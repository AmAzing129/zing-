import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  contentText,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { toToolDeclaration } from "@earendil-works/pi-ai/utils/transcript";
import {
  AssistantEntry,
  createRegistry,
  defineDoc,
  defineDocFamily,
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  section,
  SystemEntry,
  ToolResultEntry,
  ToolTask,
  UserEntry,
  watchEvents,
  type AgentEvent as DurableEvent,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type Storage,
  type SubmissionId,
  type SubmissionRecord,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";

import {
  createObserverQueue,
  createRuntimeId,
  createTurnController,
  decodeCursor,
  DEFAULT_SYSTEM,
  encodeCursor,
  normalizeLimit,
  normalizeThreadId,
  OBSERVER_TIMEOUT_MS,
  raceWithAbort,
  resolveAgentLimits,
  toError,
  toThreadEntry,
  type Agent,
  type CreateAgentOptions,
} from "./agent";
import type { AgentLimits, Blueprint } from "./blueprint";
import { createMemoryCapsule, type Capsule } from "./capsule";
import { createContextWindowPolicy } from "./context";
import type { AgentResult, CapsuleRef, IncomingMessage, Tool } from "./plugin/types";
import {
  RuntimeError,
  TurnBudgetExceededError,
  TurnCanceledError,
  type ListThreadsOptions,
  type TurnBudget as TurnBudgetKind,
  type RuntimeEvent,
  type ThreadEntry,
  type TurnHandle,
  type TurnInput,
} from "./runtime";
import type { Station } from "./station";
import { encodeMessages } from "./transcript";

const CONTEXT = BACKGROUND_CONTEXT;
const EXTENSION_NAME = "zing";
const SYSTEM_SECTION = "system";
/** How long a finished turn waits for its event stream to catch up before reporting completion anyway. */
const EVENT_DRAIN_TIMEOUT_MS = 1_000;
const ENTRY_PAGE_SIZE = 256;
const ABORT_GRACE_MS = 5_000;

type ThreadRecord = { conversationId: number; updatedAt: number };
/** Keys are threadKey(threadId): opaque IDs such as `__proto__` must not reach plain-object keys. */
type ThreadsState = { threads: { [key: string]: ThreadRecord } };
/**
 * One submitted turn: who sent it and whether observers have handled it. A turn whose observers did not finish before a
 * crash is observed again on the next start.
 */
type TurnRecord = { requestId: string; senderId?: string; observed: boolean };
/** `senderId` is the latest turn's, for tools. `turns` keeps the turns observers have not finished. */
type TurnState = { senderId?: string; turns?: TurnRecord[] };
type TurnFailure = { budget: string; message: string };

/** Zing thread IDs, which the runtime treats as opaque, mapped to durable conversations. */
const ThreadsDoc = defineDoc<ThreadsState>({
  kind: "zing.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
});

const THREAD_KEY_PREFIX = "t:";

function threadKey(threadId: string): string {
  return `${THREAD_KEY_PREFIX}${threadId}`;
}

function threadIdOf(key: string): string | undefined {
  return key.startsWith(THREAD_KEY_PREFIX) ? key.slice(THREAD_KEY_PREFIX.length) : undefined;
}

/** Each conversation's turns, so recovered tools keep their sender's trust and observers see every turn. */
const TurnDoc = defineDoc<TurnState>({
  kind: "zing.turn",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

/**
 * The budget that ended a turn, keyed by failureKey(requestId). pi-durable answers a request ID for as long as it keeps
 * the conversation, so the classification is kept as long, one small document per failed turn.
 */
const FailureDoc = defineDocFamily<TurnFailure, TurnFailure>({
  kind: "zing.turn-failure",
  version: 1,
  family: true,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (failure) => ({ ...failure }),
});

function failureKey(requestId: string): string {
  return `r:${requestId}`;
}

export type CreateDurableAgentOptions = CreateAgentOptions & {
  /** One process owns a storage at a time; pi-durable has no cross-process locking. */
  storage: Storage;
  /**
   * Called once when storage fails in a way pi-durable cannot recover from in this process. The agent has already
   * stopped taking work and is closing; reopening the storage, normally by restarting the station, resumes it.
   */
  onFatal?: (error: Error) => void;
};

type TurnBudget = {
  /** The submission's request ID, under which its failure is recorded. */
  requestId?: string;
  modelTurns: number;
  toolCalls: number;
  failure?: TurnBudgetExceededError;
  canceled: boolean;
  conversation: Conversation;
  aborting?: Promise<void>;
  deadline?: NodeJS.Timeout;
};

type ActiveTurn = TurnBudget & {
  turnId: string;
  threadId: string;
};

/**
 * The AgentRuntime on pi-durable: every model response, tool call, and transcript entry is committed before it is
 * shown, and a restarted station continues the work it left unfinished. Threads, turns, events, and plugins keep the
 * same contract as createAgent.
 */
export async function createDurableAgent(
  station: Station,
  blueprint: Blueprint,
  capsule: Capsule | undefined,
  options: CreateDurableAgentOptions,
): Promise<Agent> {
  if (blueprint.model === undefined) {
    throw new Error(`Blueprint ${blueprint.name} has no model. Set model in agent.yaml or MODEL=<id>.`);
  }
  const resolved = capsule ?? createMemoryCapsule({ blueprintName: blueprint.name });
  const model = station.resolveModel(blueprint.model);
  const modelRef = { provider: model.provider, modelId: model.id };
  const system = blueprint.system ?? DEFAULT_SYSTEM;
  const limits = resolveAgentLimits(blueprint.limits, options.limits);
  const tools = options.tools ?? [];
  const capsuleRef: CapsuleRef = { agentId: resolved.identity.agentId, state: resolved.state };
  const observers = createObserverQueue(options.listeners ?? [], options.observerTimeoutMs ?? OBSERVER_TIMEOUT_MS);
  const policy = createContextWindowPolicy(model, system, tools);

  const threads = new Map<string, ConversationId>();
  const threadOf = new Map<number, string>();
  const creating = new Map<string, Promise<Conversation>>();
  const pending = new Map<string, Promise<void>>();
  const active = new Map<string, ActiveTurn>();
  /** Threads whose turn the previous process left unfinished or unobserved. */
  const recovering = new Map<string, number>();
  const marking = new Set<Promise<void>>();
  const budgets = new Map<number, TurnBudget>();
  let harness: Harness | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let fatal: Error | undefined;

  /** A poisoned Session rejects every later commit; only reopening the storage recovers it. */
  const checkFatal = (error: unknown): void => {
    if (fatal || !isPoisoned(error)) return;
    fatal = toError(error);
    console.error("Durable storage failed; the agent stops until the station restarts", fatal);
    void close();
    options.onFatal?.(fatal);
  };

  /** Surface a poisoned Session after a failure whose own error is the storage's, not pi-durable's. */
  const probe = async (): Promise<void> => {
    try {
      await harness?.commit(() => undefined, CONTEXT);
    } catch (error) {
      checkFatal(error);
    }
  };

  const ensureOpen = (): void => {
    if (closed) {
      throw new RuntimeError("RUNTIME_CLOSED", "Agent is shutting down");
    }
  };

  const open = (): Harness => {
    if (!harness) {
      throw new RuntimeError("RUNTIME_CLOSED", "Agent is shutting down");
    }
    return harness;
  };

  const stop = (budget: TurnBudget, after: Promise<void> = Promise.resolve()): void => {
    budget.aborting ??= after
      .then(() => budget.conversation.abort(CONTEXT))
      .catch((error: unknown) => {
        if (!closed) console.warn("durable conversation abort failed", error);
      });
  };

  const fail = (budget: TurnBudget, failure: TurnBudgetExceededError): void => {
    if (budget.canceled || budget.failure) {
      stop(budget);
      return;
    }
    budget.failure = failure;
    const { requestId } = budget;
    // Recorded before the abort, so the aborted submission is always known to have failed, even across a crash.
    const recorded =
      requestId === undefined
        ? Promise.resolve()
        : budget.conversation
            .commit(async (tx) => {
              const value = { budget: failure.budget, message: failure.message };
              await tx.doc(FailureDoc, budget.conversation.id, failureKey(requestId), value);
            }, CONTEXT)
            .catch(async (error: unknown) => {
              await probe();
              if (!closed) console.warn("durable turn failure was not recorded", error);
            });
    stop(budget, recorded);
  };

  /**
   * A resumed run continues from what it already spent. Only its wall-clock limit starts over: downtime spends no
   * model or tool calls, and those counters are what bound its cost across restarts.
   */
  const createRecoveredBudget = (
    conversation: Conversation,
    requestId?: string,
    spent = { modelTurns: 0, toolCalls: 0 },
  ): TurnBudget => {
    const recovered: TurnBudget = { requestId, ...spent, canceled: false, conversation };
    recovered.deadline = setTimeout(() => {
      fail(recovered, new TurnBudgetExceededError("timeout", `Turn exceeded the ${limits.turnTimeoutMs}ms timeout`));
    }, limits.turnTimeoutMs);
    recovered.deadline.unref();
    budgets.set(conversation.id, recovered);
    return recovered;
  };

  /**
   * The budget of the run a hook fires in. A run the previous process left unfinished has no zing turn; it gets fresh
   * limits from the moment it resumes, so a recovered loop cannot run unbounded.
   */
  const budgetFor = async (id: ConversationId): Promise<TurnBudget | undefined> => {
    const current = budgets.get(id);
    if (current || closed) {
      return current;
    }
    const conversation = await open().conversation(id, CONTEXT);
    if (!conversation || budgets.has(id)) {
      return budgets.get(id);
    }
    return createRecoveredBudget(conversation);
  };

  const releaseBudget = (id: ConversationId, budget: TurnBudget): void => {
    if (budget.deadline) clearTimeout(budget.deadline);
    if (budgets.get(id) === budget) budgets.delete(id);
  };

  const extension = defineExtension({
    name: EXTENSION_NAME,
    sections: [section(SYSTEM_SECTION, () => system, { tag: false })],
    tools: tools.map((tool) =>
      createDurableTool(tool, {
        threadOf: (id) => threadOf.get(id) ?? String(id),
        senderOf: async (id, api) => (await api.snapshot(TurnDoc, id, CONTEXT))?.senderId,
        capsule: capsuleRef,
      }),
    ),
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const fitted = policy.fit([...messages]);
          const budget = await budgetFor(api.conversationId);
          if (budget && !policy.currentTurnFits(fitted)) {
            fail(
              budget,
              new TurnBudgetExceededError("context", `Current turn exceeded its ${policy.messageBudget}-token context budget`),
            );
            // Hold the request until the abort reaches this invocation, so the doomed request is never sent.
            await waitForSignal(context.abortSignal, ABORT_GRACE_MS);
          }
          return { messages: fitted };
        },
        afterResponse: async (message, api) => {
          // Error and aborted responses end or retry the run; they do not count as model turns.
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            return;
          }
          const budget = await budgetFor(api.conversationId);
          if (!budget) return;
          budget.modelTurns += 1;
          const continues = message.content.some((block) => block.type === "toolCall");
          if (continues && budget.modelTurns >= limits.maxModelTurns) {
            fail(
              budget,
              new TurnBudgetExceededError("model-turns", `Turn exceeded the ${limits.maxModelTurns} model-turn limit`),
            );
          }
        },
      }),
      hook(ToolTask, {
        beforeTool: async (_call, api) => {
          const budget = await budgetFor(api.conversationId);
          if (!budget) return undefined;
          if (budget.failure || budget.canceled) {
            return { block: budget.failure?.message ?? "Turn canceled" };
          }
          if (budget.toolCalls >= limits.maxToolCalls) {
            const failure = new TurnBudgetExceededError(
              "tool-calls",
              `Turn exceeded the ${limits.maxToolCalls} tool-call limit`,
            );
            fail(budget, failure);
            return { block: failure.message };
          }
          budget.toolCalls += 1;
          return undefined;
        },
      }),
    ],
  });

  const registry = createRegistry();
  registry.install(extension);
  harness = await Harness.open(
    options.storage,
    {
      models: createStationModels(station, model),
      registry,
      // Zing keeps its own context policy: older turns leave the request, never the transcript, and no extra model
      // call summarizes them.
      settings: { compaction: { enabled: false } },
      onReport: (error) => {
        console.warn("durable runtime report", error);
        void probe();
      },
    },
    CONTEXT,
  );

  const persisted = await harness.snapshot(ThreadsDoc, CONTEXT);
  for (const [key, record] of Object.entries(persisted?.threads ?? {})) {
    const threadId = threadIdOf(key);
    if (threadId === undefined) continue;
    threads.set(threadId, record.conversationId as ConversationId);
    threadOf.set(record.conversationId, threadId);
  }

  const baseline = (): Message => ({
    role: "system",
    content: "",
    sections: { [SYSTEM_SECTION]: system },
    ...(tools.length === 0 ? {} : { toolsAdded: tools.map((tool) => toToolDeclaration(tool)) }),
    timestamp: Date.now(),
  });

  const createConversation = async (threadId: string, updatedAt = Date.now()): Promise<Conversation> => {
    // A thread the file capsule kept before this runtime existed continues from its live history.
    const imported = await resolved.loadConversation(threadId);
    const conversation = await open().createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: modelRef },
        init: async (tx, id) => {
          (await tx.doc(ThreadsDoc)).threads[threadKey(threadId)] = { conversationId: id, updatedAt };
          if (imported.length > 0) {
            await importMessages(tx, id, [baseline(), ...(imported as Message[])]);
          }
        },
      },
      CONTEXT,
    );
    threads.set(threadId, conversation.id);
    threadOf.set(conversation.id, threadId);
    return conversation;
  };

  const findConversation = async (threadId: string): Promise<Conversation | undefined> => {
    const id = threads.get(threadId);
    if (id === undefined) return undefined;
    const conversation = await open().conversation(id, CONTEXT);
    if (!conversation) {
      throw new Error(`Durable conversation ${id} of thread ${threadId} is missing`);
    }
    return conversation;
  };

  const ensureConversation = async (threadId: string): Promise<{ conversation: Conversation; created: boolean }> => {
    const existing = await findConversation(threadId);
    if (existing) return { conversation: existing, created: false };
    let creation = creating.get(threadId);
    const created = creation === undefined;
    if (!creation) {
      creation = createConversation(threadId).finally(() => creating.delete(threadId));
      creating.set(threadId, creation);
    }
    return { conversation: await creation, created };
  };

  const touch = async (threadId: string): Promise<void> => {
    await open().commit(async (tx) => {
      const record = (await tx.doc(ThreadsDoc)).threads[threadKey(threadId)];
      if (record) record.updatedAt = Date.now();
    }, CONTEXT);
  };

  // Import every capsule thread now, so listing threads never depends on which ones were touched since.
  for (const legacy of await resolved.listConversations()) {
    if (!threads.has(legacy.conversationId)) {
      await createConversation(legacy.conversationId, legacy.updatedAt);
    }
  }

  const enqueue = <T>(threadId: string, run: () => Promise<T>): Promise<T> => {
    const previous = pending.get(threadId) ?? Promise.resolve();
    const result = previous.then(run);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    pending.set(threadId, tail);
    void tail.then(() => {
      if (pending.get(threadId) === tail) pending.delete(threadId);
    });
    return result;
  };

  /** Record that observers handled a turn. */
  const markObserved = (id: ConversationId, requestId: string, handled: Promise<void>): void => {
    const marked = handled
      .then(() =>
        open().commit(async (tx) => {
          const state = await tx.doc(TurnDoc, id);
          const turn = findTurn(state.turns, requestId);
          if (turn) turn.observed = true;
          if (state.turns) pruneTurns(state.turns);
        }, CONTEXT),
      )
      .catch(async (error: unknown) => {
        // Left unobserved: the next start reports the turn again.
        await probe();
        if (!closed) console.warn("durable turn observation was not recorded", error);
      });
    marking.add(marked);
    void marked.finally(() => marking.delete(marked));
  };

  /**
   * Report a turn the previous process did not finish observing, once it settles: observers see it like any other
   * turn, under the sender it ran for. Queued on its thread, so a new turn there starts after it.
   */
  const observeRecovered = (threadId: string, id: ConversationId, submissionId: SubmissionId): void => {
    recovering.set(threadId, (recovering.get(threadId) ?? 0) + 1);
    // Only the resumed run's own budget belongs to this submission; an earlier recovery must leave it running.
    const ownBudget = (requestId: string | undefined): TurnBudget | undefined => {
      const budget = budgets.get(id);
      return budget && !active.has(threadId) && budget.requestId === requestId ? budget : undefined;
    };
    let requestId: string | undefined;
    void enqueue(threadId, async () => {
      try {
        const submission = await open().submission(submissionId, CONTEXT);
        if (!submission) return;
        const record = await submission.wait(CONTEXT);
        requestId = record.requestId;
        const conversation = await findConversation(threadId);
        if (!conversation) return;
        const entries = await readTurnEntries(conversation, record);
        const budget = ownBudget(record.requestId);
        await budget?.aborting;
        const turn = findTurn((await open().snapshot(TurnDoc, id, CONTEXT))?.turns, record.requestId);
        const failed = budget?.failure !== undefined || (await recordedFailure(open(), id, record.requestId)) !== undefined;
        const status =
          record.status === "done" ? "completed" : record.reason === "aborted" && !failed ? "canceled" : "failed";
        const handled =
          entries.length === 0
            ? Promise.resolve()
            : observers.notify({
                type: "turn",
                conversationId: threadId,
                senderId: turn?.senderId,
                capsule: capsuleRef,
                status,
                entries,
              });
        await touch(threadId);
        if (turn) markObserved(id, turn.requestId, handled);
      } catch (error) {
        await probe();
        if (!closed) console.warn(`recovered turn of ${threadId} could not be observed`, error);
      } finally {
        const remaining = (recovering.get(threadId) ?? 1) - 1;
        if (remaining > 0) recovering.set(threadId, remaining);
        else recovering.delete(threadId);
        const budget = ownBudget(requestId);
        if (budget) releaseBudget(id, budget);
      }
    });
  };

  const unsettled = new Map<number, SubmissionRecord[]>();
  for (const record of (await harness.inspect(CONTEXT)).submissions) {
    if (record.type === "input") {
      unsettled.set(record.conversationId, [...(unsettled.get(record.conversationId) ?? []), record]);
    }
  }
  for (const [threadId, id] of threads) {
    const live = unsettled.get(id) ?? [];
    const recovered = new Set(live.map((record) => record.id));
    for (const turn of (await harness.snapshot(TurnDoc, id, CONTEXT))?.turns ?? []) {
      if (turn.observed) continue;
      // Settled before the crash, but its observers never finished; or never admitted at all.
      const record = await requestRecord(harness, id, turn.requestId);
      if (record) recovered.add(record.id);
      else markObserved(id, turn.requestId, Promise.resolve());
    }
    const conversation = live.length > 0 ? await harness.conversation(id, CONTEXT) : undefined;
    // A conversation runs one input at a time; its resumed run gets fresh limits from now.
    const resumed = live[0];
    if (conversation && resumed) {
      createRecoveredBudget(conversation, resumed.requestId, spentBudget(await readTurnRecords(conversation, resumed)));
    }
    for (const submissionId of [...recovered].sort((left, right) => left - right)) {
      observeRecovered(threadId, id, submissionId);
    }
  }
  harness.resume();

  const startTurn = (input: TurnInput): TurnHandle => {
    ensureOpen();
    const threadId = normalizeThreadId(input.threadId);
    const turnId = createRuntimeId("turn");
    let cancelRequested = false;
    const controller = createTurnController(turnId, () => {
      cancelRequested = true;
      const current = active.get(threadId);
      if (current?.turnId === turnId) {
        current.canceled = true;
        stop(current);
      }
    });

    void enqueue(threadId, async () => {
      let turn: ActiveTurn | undefined;
      let stream: Awaited<ReturnType<typeof watchEvents>> | undefined;
      let entries: ThreadEntry[] = [];
      // Every turn is submitted under a request ID, so a restart can find it to observe it.
      const requestId = input.requestId ?? `zing:${turnId}`;
      let prepared: Conversation | undefined;
      const notifyTurn = (status: "completed" | "failed" | "canceled"): void => {
        const handled =
          entries.length === 0
            ? Promise.resolve()
            : observers.notify({
                type: "turn",
                conversationId: threadId,
                senderId: input.senderId,
                capsule: capsuleRef,
                status,
                entries,
              });
        if (prepared) markObserved(prepared.id, requestId, handled);
      };
      try {
        if (closed || cancelRequested) throw new TurnCanceledError();
        const { conversation } = await ensureConversation(threadId);
        // A run the previous process left unfinished completes before this one starts.
        await conversation.waitForIdle(CONTEXT);
        if (closed || cancelRequested) throw new TurnCanceledError();

        // A repeated request ID is answered from the original turn, which observers have already seen: in its own
        // process, or, if that one died first, through the recovery queued ahead of this turn.
        const original = input.requestId === undefined ? undefined : await requestRecord(open(), conversation.id, input.requestId);
        if (original && isSettled(original)) {
          controller.emit({ type: "turn/started", threadId, turnId });
          const recorded = await recordedFailure(open(), conversation.id, input.requestId);
          if (original.status === "unanswered" && recorded) throw budgetError(recorded);
          const result = await outcome(conversation, original);
          controller.emit({ type: "turn/completed", threadId, turnId, status: "completed", result });
          controller.resolve(result);
          return;
        }

        const view = await conversation.context(CONTEXT);
        if (!policy.userInputFits(input.text, view.messages.some((message) => message.role !== "system"))) {
          throw new TurnBudgetExceededError(
            "context",
            `User input exceeded its ${policy.messageBudget}-token context budget`,
          );
        }
        await prepareConversation(conversation, modelRef, input.senderId, requestId);
        prepared = conversation;

        turn = { turnId, threadId, requestId, conversation, modelTurns: 0, toolCalls: 0, canceled: false };
        const current = turn;
        const recovered = budgets.get(conversation.id);
        if (recovered) releaseBudget(conversation.id, recovered);
        budgets.set(conversation.id, current);
        active.set(threadId, current);
        current.deadline = setTimeout(() => {
          fail(current, new TurnBudgetExceededError("timeout", `Turn exceeded the ${limits.turnTimeoutMs}ms timeout`));
        }, limits.turnTimeoutMs);
        current.deadline.unref();

        const settled = new Map<number, SubmissionRecord>();
        let target: number | undefined;
        let drained!: () => void;
        const caughtUp = new Promise<void>((resolve) => {
          drained = resolve;
        });
        const translate = createEventTranslator(threadId, turnId, controller.emit);
        stream = await watchEvents(open(), conversation.id, CONTEXT);
        stream.start(async (events) => {
          for (const event of events) {
            translate(event);
            if (event.type === "submission" && isSettled(event.record)) {
              settled.set(event.record.id, event.record);
            }
          }
          if (target !== undefined && settled.has(target)) drained();
        });

        controller.emit({ type: "turn/started", threadId, turnId });
        if (cancelRequested) throw new TurnCanceledError();
        const submission = await conversation.submit(
          { type: "input", content: input.text, requestId },
          CONTEXT,
        );
        target = submission.id;
        if (settled.has(target)) drained();
        let record = await submission.status(CONTEXT);
        if (!isSettled(record)) record = await submission.wait(CONTEXT);
        // However the settled record arrived, report the turn's events before its completion.
        await waitAtMost(caughtUp, EVENT_DRAIN_TIMEOUT_MS);

        entries = await readTurnEntries(conversation, record);
        await touch(threadId);

        if (current.canceled) throw new TurnCanceledError();
        if (current.failure) throw current.failure;
        const result = await outcome(conversation, record);
        notifyTurn("completed");
        controller.emit({ type: "turn/completed", threadId, turnId, status: "completed", result });
        controller.resolve(result);
      } catch (error) {
        if (!(error instanceof TurnCanceledError || error instanceof TurnBudgetExceededError)) await probe();
        const shuttingDown = closed && !(error instanceof TurnCanceledError) && !turn?.failure && !turn?.canceled;
        const canceled =
          !shuttingDown &&
          !(error instanceof TurnBudgetExceededError) &&
          !turn?.failure &&
          (turn?.canceled === true || error instanceof TurnCanceledError);
        if (canceled) {
          notifyTurn("canceled");
          controller.emit({ type: "turn/completed", threadId, turnId, status: "canceled" });
          controller.reject(error instanceof TurnCanceledError ? error : new TurnCanceledError());
          return;
        }
        const failed = shuttingDown
          ? new RuntimeError("RUNTIME_CLOSED", "Agent shut down; the turn resumes when the station restarts")
          : (turn?.failure ?? toError(error));
        // A turn cut off by shutdown is observed when the next start finishes it.
        if (!shuttingDown) notifyTurn("failed");
        controller.emit({
          type: "turn/completed",
          threadId,
          turnId,
          status: "failed",
          error: { message: failed.message },
        });
        controller.reject(failed);
      } finally {
        if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
        if (turn) releaseBudget(turn.conversation.id, turn);
        // The next turn of this thread starts only once this one's stream and abort are done.
        await stream?.stop().catch(() => undefined);
        await turn?.aborting;
      }
    });

    return controller.handle;
  };

  const cancelTurn = async (threadId: string, turnId: string): Promise<void> => {
    const current = active.get(normalizeThreadId(threadId));
    if (!current || current.turnId !== turnId) {
      throw new RuntimeError("TURN_NOT_ACTIVE", `Turn is not active: ${turnId}`);
    }
    current.canceled = true;
    stop(current);
  };

  const resetThread = (threadId: string): Promise<void> => {
    ensureOpen();
    const normalized = normalizeThreadId(threadId);
    return enqueue(normalized, async () => {
      try {
        const { conversation } = await ensureConversation(normalized);
        await conversation.waitForIdle(CONTEXT);
        await conversation.reset(undefined, CONTEXT);
        await conversation.waitForIdle(CONTEXT);
        await touch(normalized);
      } catch (error) {
        await probe();
        throw error;
      }
      observers.notify({ type: "reset", conversationId: normalized, capsule: capsuleRef });
    });
  };

  const close = (): Promise<void> => {
    closed = true;
    closing ??= (async () => {
      // Runs stay pending in storage; the next Harness.open resumes them. Only the waiting turn handles end here.
      for (const budget of budgets.values()) {
        if (budget.deadline) clearTimeout(budget.deadline);
      }
      // Record finished observations while storage is still open.
      await observers.drain();
      await Promise.all([...marking]);
      const current = harness;
      harness = undefined;
      try {
        await current?.close(CONTEXT);
      } catch (error) {
        // A poisoned Session may fail to close cleanly; its committed state is what the next start reads.
        if (!fatal) throw error;
      }
      await Promise.all([...pending.values()]);
      await observers.drain();
    })();
    return closing;
  };

  return {
    name: blueprint.name,
    modelId: model.id,
    agentId: resolved.identity.agentId,
    close,
    async drainObservers() {
      await observers.drain();
    },
    async handleMessage(message: IncomingMessage) {
      return startTurn({
        threadId: message.conversationId,
        text: message.text,
        senderId: message.senderId,
        requestId: message.requestId,
      }).completed;
    },
    resetConversation: resetThread,
    async openThread(threadId) {
      ensureOpen();
      const normalized = normalizeThreadId(threadId ?? createRuntimeId("thr"));
      const { created } = await ensureConversation(normalized);
      return { threadId: normalized, created };
    },
    async readThread(threadId) {
      const normalized = normalizeThreadId(threadId);
      const conversation = await findConversation(normalized);
      if (!conversation) {
        throw new RuntimeError("THREAD_NOT_FOUND", `Thread not found: ${normalized}`);
      }
      const view = await conversation.context(CONTEXT);
      return {
        threadId: normalized,
        status: active.has(normalized) || recovering.has(normalized) ? "active" : "idle",
        entries: toThreadEntries(view.entries),
      };
    },
    async listThreads(options?: ListThreadsOptions) {
      const snapshot = await open().snapshot(ThreadsDoc, CONTEXT);
      const all = Object.entries(snapshot?.threads ?? {}).flatMap(([key, record]) => {
        const threadId = threadIdOf(key);
        return threadId === undefined ? [] : [{ threadId, updatedAt: record.updatedAt }];
      });
      all.sort((left, right) => right.updatedAt - left.updatedAt || left.threadId.localeCompare(right.threadId));
      const offset = decodeCursor(options?.cursor);
      const limit = normalizeLimit(options?.limit);
      const data = all.slice(offset, offset + limit);
      const nextOffset = offset + data.length;
      return { data, nextCursor: nextOffset < all.length ? encodeCursor(nextOffset) : null };
    },
    startTurn,
    cancelTurn,
    resetThread,
  };
}

type ToolScope = {
  threadOf: (id: ConversationId) => string;
  senderOf: (id: ConversationId, api: { snapshot: Harness["snapshot"] }) => Promise<string | undefined>;
  capsule: CapsuleRef;
};

/** A zing Tool as a durable tool task. Calls are not replayed after a crash; the model sees an interrupted result. */
export function createDurableTool(tool: Tool, scope: ToolScope): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (input, api, context) => {
      const signal = context.abortSignal ?? new AbortController().signal;
      const work = (async () =>
        tool.execute(input as Record<string, unknown>, {
          signal,
          conversationId: scope.threadOf(api.conversationId),
          senderId: await scope.senderOf(api.conversationId, api),
          capsule: scope.capsule,
        }))();
      const result = await raceWithAbort(work, signal, `${tool.name} aborted`);
      return {
        content: [{ type: "text", text: result.text }],
        // pi-ai and Chord describe the same JSON; they differ only in readonly arrays.
        details: (result.details ?? null) as JsonValue,
      };
    },
  });
}

/** The station's models with each provider plugin's API key, and the blueprint's resolved model under its own ref. */
function createStationModels(station: Station, model: Model<Api>): Models {
  const base = station.models;
  const withKey = <O extends { apiKey?: string }>(target: Model<Api>, options: O | undefined): O | undefined => {
    if (options?.apiKey !== undefined) return options;
    const apiKey = station.getApiKey(target.provider);
    return apiKey === undefined ? options : ({ ...options, apiKey } as O);
  };
  const overrides: Partial<Models> = {
    getModel: (provider, id) =>
      provider === model.provider && id === model.id ? model : base.getModel(provider, id),
    stream: (target, context, options) => base.stream(target, context, withKey(target, options)),
    complete: (target, context, options) => base.complete(target, context, withKey(target, options)),
    streamSimple: (target, context, options) => base.streamSimple(target, context, withKey(target, options)),
    completeSimple: (target, context, options) => base.completeSimple(target, context, withKey(target, options)),
    streamDeferred: (target, handle, options) => base.streamDeferred(target, handle, withKey(target, options)),
    fetchDeferred: (target, handle, options) => base.fetchDeferred(target, handle, withKey(target, options)),
    cancelDeferred: (target, handle, options) => base.cancelDeferred(target, handle, withKey(target, options)),
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (Object.hasOwn(overrides, property)) {
        return overrides[property as keyof Models];
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function prepareConversation(
  conversation: Conversation,
  model: { provider: string; modelId: string },
  senderId: string | undefined,
  requestId: string,
): Promise<void> {
  const agent = await conversation.agent(CONTEXT);
  await conversation.commit(async (tx) => {
    const turn = await tx.doc(TurnDoc, conversation.id);
    if (senderId === undefined) {
      delete turn.senderId;
    } else {
      turn.senderId = senderId;
    }
    turn.turns ??= [];
    const index = turn.turns.findIndex((record) => record.requestId === requestId);
    if (index >= 0) turn.turns.splice(index, 1);
    turn.turns.push({ requestId, ...(senderId === undefined ? {} : { senderId }), observed: false });
    pruneTurns(turn.turns);
  }, CONTEXT);
  // The blueprint decides the model; conversations created under another one follow it.
  if (agent.model?.provider !== model.provider || agent.model.modelId !== model.modelId) {
    await conversation.configure({ model }, CONTEXT);
  }
}

async function importMessages(tx: Tx, id: ConversationId, messages: readonly Message[]): Promise<void> {
  for (const message of messages) {
    if (message.role === "system") {
      await tx.appendEntry(SystemEntry, id, { model: [message] });
    } else if (message.role === "user") {
      await tx.appendEntry(UserEntry, id, { model: [message] });
    } else if (message.role === "assistant") {
      await tx.appendEntry(AssistantEntry, id, { model: [message] });
    } else {
      await tx.appendEntry(ToolResultEntry, id, { model: [message], data: { diagnostics: [] } });
    }
  }
}

function findTurn<T extends TurnRecord>(turns: T[] | readonly T[] | undefined, requestId: string | undefined): T | undefined {
  return requestId === undefined ? undefined : turns?.find((turn) => turn.requestId === requestId);
}

/** Drop the turns observers have handled. */
function pruneTurns(turns: TurnRecord[]): void {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.observed) turns.splice(index, 1);
  }
}

async function recordedFailure(
  harness: Harness,
  id: ConversationId,
  requestId: string | undefined,
): Promise<TurnFailure | undefined> {
  return requestId === undefined ? undefined : harness.snapshot(FailureDoc, id, failureKey(requestId), CONTEXT);
}

const BUDGETS = new Set<string>(["context", "model-turns", "timeout", "tool-calls"]);

function budgetError(failure: TurnFailure): Error {
  return BUDGETS.has(failure.budget)
    ? new TurnBudgetExceededError(failure.budget as TurnBudgetKind, failure.message)
    : new Error(failure.message);
}

function requestRecord(harness: Harness, id: ConversationId, requestId: string): Promise<SubmissionRecord | undefined> {
  return harness.commit((tx) => tx.submissionByRequest(id, requestId), CONTEXT);
}

/**
 * The entries one settled input added: its user entry through its answer, or, when unanswered, up to the next user
 * entry. Zing submits one input at a time per thread, so the next user entry starts the next turn.
 */
async function readTurnEntries(conversation: Conversation, record: SubmissionRecord): Promise<ThreadEntry[]> {
  return toThreadEntries(await readTurnRecords(conversation, record));
}

async function readTurnRecords(conversation: Conversation, record: SubmissionRecord): Promise<EntryRecord[]> {
  if (record.entry === undefined) return [];
  const last = record.status === "done" && record.type === "input" ? record.answer : undefined;
  const records: EntryRecord[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  scan: do {
    const page = await conversation.entries(
      { minEntryId: record.entry, ...(last === undefined ? {} : { maxEntryId: last }), order: "ascending" },
      ENTRY_PAGE_SIZE,
      cursor,
      CONTEXT,
    );
    for (const entry of page.items) {
      if (entry.id !== record.entry && UserEntry.is(entry)) break scan;
      records.push(entry);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return records;
}

/**
 * What a turn has already spent: its answered model responses, and the tool calls they made. A call cut off by the crash
 * has no result yet, so calls are counted from the responses; one that was blocked or never started counts too, which
 * only errs toward stopping sooner.
 */
function spentBudget(records: readonly EntryRecord[]): { modelTurns: number; toolCalls: number } {
  let modelTurns = 0;
  let toolCalls = 0;
  for (const record of records) {
    const message = record.model?.[0];
    if (!AssistantEntry.is(record) || message?.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    modelTurns += 1;
    toolCalls += message.content.filter((block) => block.type === "toolCall").length;
  }
  return { modelTurns, toolCalls };
}

function toThreadEntries(records: readonly EntryRecord[]): ThreadEntry[] {
  const messages = records
    .filter((record) => UserEntry.is(record) || AssistantEntry.is(record) || ToolResultEntry.is(record))
    .flatMap((record) => record.model ?? []);
  return encodeMessages(messages).map(toThreadEntry);
}

async function outcome(conversation: Conversation, record: SubmissionRecord): Promise<AgentResult> {
  if (record.status === "done" && record.type === "input") {
    const page = await conversation.entries(
      { minEntryId: record.answer, maxEntryId: record.answer },
      1,
      undefined,
      CONTEXT,
    );
    const answer = page.items[0]?.model?.[0];
    return { text: answer?.role === "assistant" ? contentText(answer.content).trim() : "" };
  }
  if (record.status === "unanswered") {
    if (record.reason === "aborted") throw new TurnCanceledError();
    if (record.reason === "model_error") {
      throw new Error(typeof record.detail === "string" && record.detail ? record.detail : "model error");
    }
    throw new Error(`Turn was not answered: ${record.reason}`);
  }
  throw new Error(`Turn ended in unexpected state: ${record.status}`);
}

function isPoisoned(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current.message.startsWith("Session is poisoned")) return true;
  }
  return false;
}

function isSettled(record: SubmissionRecord): boolean {
  return record.status === "done" || record.status === "unanswered";
}

async function waitAtMost(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForSignal(signal: AbortSignal | undefined, timeoutMs: number): Promise<void> {
  if (!signal || signal.aborted) return;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(resolve, timeoutMs);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

/** pi-durable agent events of one run as zing runtime events. */
function createEventTranslator(
  threadId: string,
  turnId: string,
  emit: (event: RuntimeEvent) => void,
): (event: DurableEvent) => void {
  let messageId: string | undefined;
  let messageHasText = false;

  const delta = (text: string): void => {
    if (!text) return;
    messageId ??= createRuntimeId("msg");
    messageHasText = true;
    emit({ type: "message/delta", threadId, turnId, messageId, delta: text });
  };

  return (event) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      messageId = undefined;
      messageHasText = false;
      // A response committed in one step arrives whole; later updates carry only what follows.
      for (const block of event.message.content) {
        if (block.type === "text") delta(block.text);
      }
      return;
    }
    if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type === "text_delta") delta(change.delta);
        else if (change.type === "text_start" && change.block.type === "text") delta(change.block.text);
      }
      return;
    }
    if (event.type === "message_end") {
      const message = event.entry.model?.[0];
      if (!AssistantEntry.is(event.entry) || message?.role !== "assistant") return;
      const text = contentText((message as AssistantMessage).content);
      if (messageHasText || text) {
        messageId ??= createRuntimeId("msg");
        emit({ type: "message/completed", threadId, turnId, messageId, text });
      }
      messageId = undefined;
      messageHasText = false;
      return;
    }
    if (event.type === "tool_execution_start") {
      emit({
        type: "tool/started",
        threadId,
        turnId,
        callId: event.toolCallId,
        name: event.toolName,
        input: event.args,
      });
      return;
    }
    if (event.type === "tool_execution_end") {
      const result = event.entry?.model?.[0];
      emit({
        type: "tool/completed",
        threadId,
        turnId,
        callId: event.toolCallId,
        name: event.toolName,
        isError: result?.role === "toolResult" ? result.isError : true,
      });
    }
  };
}

export type { AgentLimits };
