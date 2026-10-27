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
  defineExtension,
  defineTool,
  GenerationTask,
  Harness,
  hook,
  LiveDoc,
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
  type Submission,
  type SubmissionRecord,
  type ToolExecutionResult,
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
  withBuiltinTools,
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
import { composeSystemPrompt, promptSections, tagSection } from "./prompt";
import { SKILL_TOOL_NAME } from "./skills";
import type { Station } from "./station";
import { encodeMessages } from "./transcript";

const CONTEXT = BACKGROUND_CONTEXT;
const EXTENSION_NAME = "zing";
const SYSTEM_SECTION = "system";
/** How long a finished turn waits for its event stream to catch up before reporting completion anyway. */
const EVENT_DRAIN_TIMEOUT_MS = 1_000;
const ENTRY_PAGE_SIZE = 256;
const BUDGET_FAILURE_PREFIX = "zing:budget:";

type ThreadRecord = { conversationId: number; updatedAt: number };
/** Keys are threadKey(threadId): opaque IDs such as `__proto__` must not reach plain-object keys. */
type ThreadsState = { threads: { [key: string]: ThreadRecord } };
/**
 * One submitted turn: who sent it and whether observers have handled it. A turn whose observers did not finish before a
 * crash is observed again on the next start.
 */
type TurnRecord = { requestId: string; senderId?: string; observed: boolean; deadlineAt?: number; timeoutMs?: number };
/** `senderId` is the latest turn's, for tools. `turns` keeps the turns observers have not finished. */
type TurnState = { senderId?: string; turns?: TurnRecord[] };
type TurnFailure = { budget: string; message: string };

/** Zing thread IDs, which the runtime treats as opaque, mapped to durable conversations. */
const ThreadsDoc = defineDoc<ThreadsState>({
  kind: "zing.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
  checkpointWhen: () => false,
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
  checkpointWhen: () => false,
});

export type CreateDurableAgentOptions = CreateAgentOptions & {
  /** One process owns a storage at a time; pi-durable has no cross-process locking. */
  storage: Storage;
  /**
   * Called once, with the storage error, when a storage error has failed pi-durable's Session: pi-durable retries
   * nothing, so this process can do no more work. The agent has already stopped taking work and is closing; reopening
   * the storage, normally by restarting the station, resumes it.
   */
  onFatal?: (error: Error) => void;
};

type TurnBudget = {
  requestId: string;
  canceled: boolean;
  /** A committed receipt reached this process; only completion bookkeeping remains. */
  settled?: boolean;
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
  const skills = options.skills ?? [];
  const subagents = options.subagents ?? [];
  const sections = promptSections(skills, subagents);
  const limits = resolveAgentLimits(blueprint.limits, options.limits);
  const tools = withBuiltinTools(station, model.id, options.tools ?? [], skills, subagents);
  const capsuleRef: CapsuleRef = { agentId: resolved.identity.agentId, state: resolved.state };
  const observers = createObserverQueue(options.listeners ?? [], options.observerTimeoutMs ?? OBSERVER_TIMEOUT_MS);
  const policy = createContextWindowPolicy(model, composeSystemPrompt(system, skills, subagents), tools);

  const threads = new Map<string, ConversationId>();
  const threadOf = new Map<number, string>();
  const creating = new Map<string, Promise<Conversation>>();
  const pending = new Map<string, Promise<void>>();
  const active = new Map<string, ActiveTurn>();
  const marking = new Set<Promise<void>>();
  const budgets = new Map<number, TurnBudget>();
  let harness: Harness | undefined;
  let resumed = false;
  let closed = false;
  /** cancelAll() ran: no turn may run any more, including one admitted while it was canceling. */
  let canceling = false;
  let closing: Promise<void> | undefined;
  /** A storage error failed the Session, which then closed itself. */
  let sessionFailed = false;

  const close = (): Promise<void> => {
    closed = true;
    closing ??= (async () => {
      for (const budget of budgets.values()) {
        if (budget.deadline) clearTimeout(budget.deadline);
      }
      // Explicit cancellations must be durable before storage closes. Other unfinished runs remain resumable.
      await Promise.all([...budgets.values()].map((budget) => budget.aborting));
      // Finish receipts already delivered to this process before closing their storage, including when an event
      // listener initiated close(). Do not wait on unfinished turns: harness.close suspends those for recovery.
      await Promise.all(
        [...pending].flatMap(([threadId, tail]) => {
          const id = threads.get(threadId);
          const budget = id === undefined ? undefined : budgets.get(id);
          return !budget || budget.settled ? [tail] : [];
        }),
      );
      await observers.drain();
      await Promise.all([...marking]);
      const current = harness;
      harness = undefined;
      try {
        await current?.close(CONTEXT);
      } catch (error) {
        if (!sessionFailed) throw error;
      }
      await Promise.all([...pending.values()]);
      await observers.drain();
    })();
    return closing;
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

  /**
   * Run storage work a turn depends on: its failure, its abort, its observation. It is not retried: a storage error
   * fails the Session, and every later call would fail the same way. The next start resumes the run and replays its
   * observation.
   */
  const attempt = async <T>(what: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      if (!closed) console.warn(`durable ${what} failed`, error);
      return undefined;
    }
  };

  const stop = (budget: TurnBudget): void => {
    budget.aborting ??= attempt("conversation abort", () => budget.conversation.abort(CONTEXT));
  };

  const fail = async (budget: TurnBudget, failure: TurnBudgetExceededError): Promise<void> => {
    // The submission is the only outcome authority. In particular, a deadline waiting behind an answer commit
    // must not rewrite that answer. Abort cleanup may lag this commit; startup fences it before resuming tasks.
    const failed = await attempt("turn failure", () =>
      budget.conversation.commit(async (tx) => {
        const record = await tx.submissionByRequest(budget.conversation.id, budget.requestId);
        if (!record || isSettled(record)) return false;
        tx.settleSubmission(record.id, {
          status: "unanswered",
          reason: "faulted",
          detail: `${BUDGET_FAILURE_PREFIX}${JSON.stringify({ budget: failure.budget, message: failure.message })}`,
        });
        return true;
      }, CONTEXT),
    );
    if (failed && resumed) stop(budget);
  };

  /** Only the wake-up timer is process-local; its deadline and all spent work are durable. */
  const createRecoveredBudget = (conversation: Conversation, turn: TurnRecord): TurnBudget => {
    const recovered: TurnBudget = { requestId: turn.requestId, canceled: false, conversation };
    const timeoutMs = turn.timeoutMs ?? limits.turnTimeoutMs;
    recovered.deadline = setTimeout(
      () => {
        void fail(recovered, new TurnBudgetExceededError("timeout", `Turn exceeded the ${timeoutMs}ms timeout`)).catch(
          (error) => {
            if (!closed) console.warn("durable deadline failed", error);
          },
        );
      },
      Math.max(0, (turn.deadlineAt ?? Date.now() + timeoutMs) - Date.now()),
    );
    recovered.deadline.unref();
    // A budget is replaced only once its run has ended, so the earlier deadline has nothing left to stop.
    const previous = budgets.get(conversation.id);
    if (previous?.deadline) clearTimeout(previous.deadline);
    budgets.set(conversation.id, recovered);
    return recovered;
  };

  const releaseBudget = (id: ConversationId, budget: TurnBudget): void => {
    if (budget.deadline) clearTimeout(budget.deadline);
    if (budgets.get(id) === budget) budgets.delete(id);
  };

  /**
   * The budget of the run a hook fires in. Limits never depend on this process's memory alone: if it has no budget for
   * the run (for example one still stopping after its turn settled), the run's request, and with it its deadline and
   * spend, come from durable state.
   */
  const budgetOf = async (id: ConversationId): Promise<TurnBudget | undefined> => {
    const known = budgets.get(id);
    if (known) return known;
    const input = (await open().snapshot(LiveDoc, id, CONTEXT))?.run?.inputs[0];
    const record = input === undefined ? undefined : await (await open().submission(input, CONTEXT))?.status(CONTEXT);
    if (record?.requestId === undefined) return undefined;
    const conversation = await open().conversation(id, CONTEXT);
    if (!conversation) return undefined;
    const turn = findTurn((await open().snapshot(TurnDoc, id, CONTEXT))?.turns, record.requestId);
    // Registered with its deadline armed, so a call that hangs after this hook still times out.
    const recorded = turn ?? { requestId: record.requestId, observed: false };
    return budgets.get(id) ?? createRecoveredBudget(conversation, recorded);
  };

  /**
   * Hold a hook whose run already has its outcome until its abort lands, so the run spends nothing more. Throwing
   * instead would not end the run: pi-durable reports and skips a hook's error. Closing the harness aborts the hold too.
   */
  const holdUntilAborted = async (budget: TurnBudget, signal: AbortSignal | undefined): Promise<void> => {
    stop(budget);
    await waitForSignal(signal);
  };

  const checkDeadline = async (budget: TurnBudget): Promise<void> => {
    const turn = findTurn((await open().snapshot(TurnDoc, budget.conversation.id, CONTEXT))?.turns, budget.requestId);
    if (turn?.deadlineAt !== undefined && turn.deadlineAt <= Date.now()) {
      await fail(
        budget,
        new TurnBudgetExceededError("timeout", `Turn exceeded the ${turn.timeoutMs ?? limits.turnTimeoutMs}ms timeout`),
      );
    }
  };

  const extension = defineExtension({
    name: EXTENSION_NAME,
    sections: [
      section(SYSTEM_SECTION, () => system, { tag: false }),
      ...sections.map(([key, text]) => section(key, () => text)),
    ],
    tools: tools.map((tool) => {
      const registration = createDurableTool(tool, {
        threadOf: (id) => threadOf.get(id) ?? String(id),
        senderOf: async (id, api) => (await api.snapshot(TurnDoc, id, CONTEXT))?.senderId,
        capsule: capsuleRef,
      });
      // Loading a skill only reads, so a call a crash interrupted runs again instead of failing.
      return tool.name === SKILL_TOOL_NAME ? { ...registration, replay: "safe" as const } : registration;
    }),
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const fitted = policy.fit([...messages]);
          const budget = await budgetOf(api.conversationId);
          if (budget) {
            await checkDeadline(budget);
            const record = await requestRecord(open(), api.conversationId, budget.requestId);
            if (record && isSettled(record)) {
              stop(budget);
              await holdUntilAborted(budget, context.abortSignal);
              return { messages: fitted };
            }
          }
          if (budget && !policy.currentTurnFits(fitted)) {
            await fail(
              budget,
              new TurnBudgetExceededError(
                "context",
                `Current turn exceeded its ${policy.messageBudget}-token context budget`,
              ),
            );
            // Hold the request until the abort reaches this invocation, so the doomed request is never sent.
            await holdUntilAborted(budget, context.abortSignal);
          }
          return { messages: fitted };
        },
        afterResponse: async (message, api, context) => {
          // Error and aborted responses end or retry the run; they do not count as model turns.
          if (message.stopReason === "error" || message.stopReason === "aborted") {
            return;
          }
          const budget = await budgetOf(api.conversationId);
          if (!budget) return;
          await checkDeadline(budget);
          const record = await requestRecord(open(), api.conversationId, budget.requestId);
          if (!record) return;
          if (isSettled(record)) {
            stop(budget);
            await holdUntilAborted(budget, context.abortSignal);
            return;
          }
          const spent = spentBudget(await readTurnRecords(budget.conversation, record));
          const continues = message.content.some((block) => block.type === "toolCall");
          if (continues && spent.modelTurns + 1 >= limits.maxModelTurns) {
            await fail(
              budget,
              new TurnBudgetExceededError("model-turns", `Turn exceeded the ${limits.maxModelTurns} model-turn limit`),
            );
            await holdUntilAborted(budget, context.abortSignal);
          }
        },
      }),
      hook(ToolTask, {
        beforeTool: async (_call, api) => {
          const budget = await budgetOf(api.conversationId);
          if (!budget) return undefined;
          await checkDeadline(budget);
          const record = await requestRecord(open(), api.conversationId, budget.requestId);
          if (!record || isSettled(record) || budget.canceled) return { block: "Turn ended" };
          const records = await readTurnRecords(budget.conversation, record);
          const slots = (await api.snapshot(LiveDoc, api.conversationId, CONTEXT))?.tools ?? [];
          // Task IDs distinguish repeated model call IDs across rounds. Count the current call's position,
          // not the entire batch, so the allowed prefix can execute and only excess calls are blocked.
          const ordinal =
            spentBudget(records).toolCalls - slots.length + slots.findIndex((slot) => slot.taskId === api.taskId);
          if (ordinal >= limits.maxToolCalls) {
            const failure = new TurnBudgetExceededError(
              "tool-calls",
              `Turn exceeded the ${limits.maxToolCalls} tool-call limit`,
            );
            await fail(budget, failure);
            return { block: failure.message };
          }
          return undefined;
        },
      }),
    ],
  });

  const registry = createRegistry();
  registry.install(extension);

  const baseline = (): Message => ({
    role: "system",
    content: "",
    sections: {
      [SYSTEM_SECTION]: system,
      ...Object.fromEntries(sections.map(([key, text]) => [key, tagSection(key, text)])),
    },
    ...(tools.length === 0 ? {} : { toolsAdded: tools.map((tool) => toToolDeclaration(tool)) }),
    timestamp: Date.now(),
  });

  const createConversation = async (
    threadId: string,
    updatedAt = Date.now(),
    history?: Awaited<ReturnType<Capsule["loadConversation"]>>,
  ): Promise<Conversation> => {
    // A thread the file capsule kept before this runtime existed continues from its live history.
    const imported = history ?? (await resolved.loadConversation(threadId));
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
  const markObserved = (id: ConversationId, requestId: string, handled: Promise<void>): Promise<void> => {
    const marked = handled
      .then(() =>
        open().commit(async (tx) => {
          const state = await tx.doc(TurnDoc, id);
          const turn = findTurn(state.turns, requestId);
          if (turn) turn.observed = true;
          if (state.turns) pruneTurns(state.turns);
        }, CONTEXT),
      )
      .catch((error: unknown) => {
        // Left unobserved: the next start reports the turn again.
        if (!closed) console.warn("durable turn observation was not recorded", error);
      });
    marking.add(marked);
    void marked.finally(() => marking.delete(marked));
    return marked;
  };

  const observing = new Set<SubmissionId>();
  /** The same durable settlement consumer handles live turns, recovery, and request redelivery. */
  const observeTurn = async (threadId: string, conversation: Conversation, record: SubmissionRecord): Promise<void> => {
    const turn = findTurn((await open().snapshot(TurnDoc, conversation.id, CONTEXT))?.turns, record.requestId);
    if (!turn || turn.observed || observing.has(record.id)) return;
    const entries = await readTurnEntries(conversation, record);
    await touch(threadId);
    observing.add(record.id);
    const status =
      record.status === "done"
        ? "completed"
        : record.status === "unanswered" && record.reason === "aborted"
          ? "canceled"
          : "failed";
    const handled =
      entries.length === 0
        ? Promise.resolve()
        : observers.notify({
            type: "turn",
            conversationId: threadId,
            senderId: turn.senderId,
            capsule: capsuleRef,
            status,
            entries,
          });
    void markObserved(conversation.id, turn.requestId, handled).finally(() => observing.delete(record.id));
  };

  /**
   * Observe a settled turn once its run has stopped: the same step for a live turn, a detached or recovered run, and a
   * redelivery.
   */
  const observeSettled = async (threadId: string, id: ConversationId, record: SubmissionRecord): Promise<void> => {
    await attempt("turn observation", async () => {
      const conversation = await open().conversation(id, CONTEXT);
      if (!conversation) return;
      // A run settled by a limit may still be stopping; the rest of its transcript arrives with its abort.
      if ((await open().snapshot(LiveDoc, id, CONTEXT))?.run?.inputs.includes(record.id)) {
        await conversation.waitForIdle(CONTEXT);
      }
      await observeTurn(threadId, conversation, record);
    });
  };

  /** Recovery uses the same per-thread ordering and settlement consumer as a newly admitted turn. */
  const observeRecovered = (threadId: string, id: ConversationId, submissionId: SubmissionId): void => {
    // Only the resumed run's own budget belongs to this submission; an earlier recovery must leave it running.
    const ownBudget = (requestId: string | undefined): TurnBudget | undefined => {
      const budget = budgets.get(id);
      return budget && !active.has(threadId) && budget.requestId === requestId ? budget : undefined;
    };
    let requestId: string | undefined;
    void enqueue(threadId, async () => {
      try {
        const record = await attempt("recovered turn", async () => {
          const submission = await open().submission(submissionId, CONTEXT);
          return submission === undefined ? null : await submission.wait(CONTEXT);
        });
        if (!record) return;
        requestId = record.requestId;
        // Settled: bookkeeping that follows must not be able to time out the finished run.
        const budget = ownBudget(record.requestId);
        if (budget) budget.settled = true;
        const deadline = budget?.deadline;
        if (deadline) clearTimeout(deadline);
        await observeSettled(threadId, id, record);
      } finally {
        const budget = ownBudget(requestId);
        if (budget) releaseBudget(id, budget);
      }
    });
  };

  // No operation that enables scheduling may run until every conversation has been checked.
  try {
    harness = await Harness.open(
      options.storage,
      {
        models: createStationModels(station, model),
        registry,
        // Zing fits model context itself; keep the original transcript and make no summarization calls.
        settings: { compaction: { enabled: false } },
        onReport: (error) => console.warn("durable runtime report", error),
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
    for (const legacy of await resolved.listConversations()) {
      if (threads.has(legacy.conversationId)) continue;
      let history: Awaited<ReturnType<Capsule["loadConversation"]>>;
      try {
        history = await resolved.loadConversation(legacy.conversationId);
      } catch (error) {
        // Leave this thread unavailable, rather than silently replacing its history with an empty one.
        console.warn(`Legacy thread ${legacy.conversationId} could not be imported`, error);
        continue;
      }
      await createConversation(legacy.conversationId, legacy.updatedAt, history);
    }
    const unsettled = new Map<number, SubmissionRecord[]>();
    for (const record of (await harness.inspect(CONTEXT)).submissions) {
      if (record.type === "input") {
        unsettled.set(record.conversationId, [...(unsettled.get(record.conversationId) ?? []), record]);
      }
    }
    const recoveries: Array<{ threadId: string; id: ConversationId; submissionId: SubmissionId }> = [];
    for (const [threadId, id] of threads) {
      const live = unsettled.get(id) ?? [];
      const recovered = new Set(live.map((record) => record.id));
      const turns = (await harness.snapshot(TurnDoc, id, CONTEXT))?.turns ?? [];
      for (const turn of turns) {
        if (turn.observed) continue;
        // Settled before the crash, but its observers never finished; or never admitted at all.
        const record = await requestRecord(harness, id, turn.requestId);
        if (record) recovered.add(record.id);
        else markObserved(id, turn.requestId, Promise.resolve());
      }
      const conversation = await harness.conversation(id, CONTEXT);
      const resumed = live[0];
      if (conversation && resumed?.requestId) {
        const turn = findTurn(turns, resumed.requestId) ?? { requestId: resumed.requestId, observed: false };
        const budget = createRecoveredBudget(conversation, turn);
        if (turn.deadlineAt !== undefined && turn.deadlineAt <= Date.now()) {
          await fail(
            budget,
            new TurnBudgetExceededError(
              "timeout",
              `Turn exceeded the ${turn.timeoutMs ?? limits.turnTimeoutMs}ms timeout`,
            ),
          );
        }
      }
      // A process may have died after settlement but before abort cleanup. Fence that generation (and its owned
      // tools) before resume; never let a terminal submission spend more model or tool budget on restart.
      const run = (await harness.snapshot(LiveDoc, id, CONTEXT))?.run;
      if (run) {
        const records = await Promise.all(
          run.inputs.map(async (input) => (await harness!.submission(input, CONTEXT))?.status(CONTEXT)),
        );
        if (records.every((record) => record !== undefined && isSettled(record))) {
          await harness.abortTask(run.taskId, CONTEXT);
        }
      }
      for (const submissionId of [...recovered].sort((left, right) => left - right)) {
        recoveries.push({ threadId, id, submissionId });
      }
    }
    const opened = harness;
    // Runs synchronously as the Session starts closing, before the call that hit a storage error sees it.
    opened.subscribeClose(() => {
      if (harness !== opened) return;
      sessionFailed = true;
      closed = true;
    });
    void opened.closed.then((end) => {
      if (end.reason !== "failed") return;
      const error = toError(end.error);
      console.error("Durable storage failed; the agent stops until the station restarts", error);
      void close();
      options.onFatal?.(error);
    });
    resumed = true;
    for (const { threadId, id, submissionId } of recoveries) observeRecovered(threadId, id, submissionId);
    harness.resume();
  } catch (error) {
    closed = true;
    for (const budget of budgets.values()) {
      if (budget.deadline) clearTimeout(budget.deadline);
    }
    try {
      if (harness) await harness.close(CONTEXT);
      else await options.storage.close(CONTEXT);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Durable agent initialization and cleanup failed");
    }
    throw error;
  }

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
      let settledRecord: SubmissionRecord | undefined;
      let submitted: Submission | undefined;
      // Every turn is submitted under a request ID, so a restart can find it to observe it.
      const requestId = input.requestId ?? `zing:${turnId}`;
      try {
        if (closed || cancelRequested) throw new TurnCanceledError();
        const { conversation } = await ensureConversation(threadId);
        // A run the previous process left unfinished completes before this one starts.
        await conversation.waitForIdle(CONTEXT);
        if (closed || cancelRequested) throw new TurnCanceledError();

        // A repeated request ID is answered from the original turn, which observers have already seen: in its own
        // process, or, if that one died first, through the recovery queued ahead of this turn.
        const original =
          input.requestId === undefined ? undefined : await requestRecord(open(), conversation.id, input.requestId);
        if (original && isSettled(original)) {
          controller.emit({ type: "turn/started", threadId, turnId });
          settledRecord = original;
          await observeSettled(threadId, conversation.id, original);
          const result = await outcome(conversation, original);
          controller.emit({ type: "turn/completed", threadId, turnId, status: "completed", result });
          controller.resolve(result);
          return;
        }

        const history = await conversation.entries({ order: "descending" }, 1, undefined, CONTEXT);
        if (
          !policy.userInputFits(
            input.text,
            history.items.some((entry) => entry.model?.some((message) => message.role !== "system")),
          )
        ) {
          throw new TurnBudgetExceededError(
            "context",
            `User input exceeded its ${policy.messageBudget}-token context budget`,
          );
        }
        const metadata: TurnRecord = {
          requestId,
          ...(input.senderId === undefined ? {} : { senderId: input.senderId }),
          observed: false,
          deadlineAt: Date.now() + limits.turnTimeoutMs,
          timeoutMs: limits.turnTimeoutMs,
        };
        await prepareConversation(conversation, modelRef, metadata);
        turn = Object.assign(createRecoveredBudget(conversation, metadata), { turnId, threadId });
        const current = turn;
        active.set(threadId, current);

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
              if (event.record.requestId === requestId) current.settled = true;
            }
          }
          if (target !== undefined && settled.has(target)) drained();
        });

        controller.emit({ type: "turn/started", threadId, turnId });
        if (cancelRequested || canceling) throw new TurnCanceledError();
        const submission = await conversation.submit({ type: "input", content: input.text, requestId }, CONTEXT);
        submitted = submission;
        target = submission.id;
        if (canceling) {
          current.canceled = true;
          stop(current);
        }
        if (settled.has(target)) drained();
        let record = await submission.status(CONTEXT);
        if (!isSettled(record)) record = await submission.wait(CONTEXT);
        // The durable record now decides the outcome, as it will for a redelivery or a restart: limits and
        // cancellation can no longer change work that already settled.
        settledRecord = record;
        current.settled = true;
        if (current.deadline) clearTimeout(current.deadline);
        if (active.get(threadId)?.turnId === turnId) active.delete(threadId);
        // However the settled record arrived, report the turn's events before its completion.
        await waitAtMost(caughtUp, EVENT_DRAIN_TIMEOUT_MS);

        await observeSettled(threadId, conversation.id, record);
        const result = await outcome(conversation, record);
        controller.emit({ type: "turn/completed", threadId, turnId, status: "completed", result });
        controller.resolve(result);
      } catch (error) {
        // After a storage failure an unsettled turn resumes on restart, even a canceled one whose abort did not commit.
        const shuttingDown =
          closed &&
          !settledRecord &&
          !(error instanceof TurnCanceledError) &&
          (sessionFailed || turn?.canceled !== true);
        const canceled = settledRecord
          ? error instanceof TurnCanceledError
          : !shuttingDown &&
            !(error instanceof TurnBudgetExceededError) &&
            (turn?.canceled === true || error instanceof TurnCanceledError);
        if (canceled) {
          controller.emit({ type: "turn/completed", threadId, turnId, status: "canceled" });
          controller.reject(error instanceof TurnCanceledError ? error : new TurnCanceledError());
          return;
        }
        const failed = shuttingDown
          ? new RuntimeError("RUNTIME_CLOSED", "Agent shut down; the turn resumes when the station restarts")
          : toError(error);
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
        // The caller has its outcome; later events of the run are not this turn's to report.
        await stream?.stop().catch(() => undefined);
        // A submitted turn stops waiting unsettled only when the Session closes; its run resumes on the next start.
        if (turn && (settledRecord || !submitted)) releaseBudget(turn.conversation.id, turn);
        // The next turn of this thread starts only once this one's abort is done.
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

  /**
   * Stop taking turns and durably cancel every queued, running, and recovered one. A graceful stop whose drain ran out
   * of time uses this, so nothing resumes after the restart for a caller that is gone.
   */
  const cancelAll = async (): Promise<void> => {
    if (canceling || closing || !harness) return;
    canceling = true;
    closed = true;
    const stopping: TurnBudget[] = [];
    for (const record of (await open().inspect(CONTEXT)).submissions) {
      if (record.type !== "input") continue;
      let budget = budgets.get(record.conversationId);
      if (!budget) {
        const conversation = await open().conversation(record.conversationId, CONTEXT);
        if (!conversation) continue;
        budget = { requestId: record.requestId ?? "", canceled: false, conversation };
      }
      budget.canceled = true;
      stop(budget);
      stopping.push(budget);
    }
    await Promise.all(stopping.map((budget) => budget.aborting));
  };

  const resetThread = (threadId: string): Promise<void> => {
    ensureOpen();
    const normalized = normalizeThreadId(threadId);
    return enqueue(normalized, async () => {
      const { conversation } = await ensureConversation(normalized);
      await conversation.waitForIdle(CONTEXT);
      await conversation.reset(undefined, CONTEXT);
      await conversation.waitForIdle(CONTEXT);
      await touch(normalized);
      observers.notify({ type: "reset", conversationId: normalized, capsule: capsuleRef });
    });
  };

  return {
    name: blueprint.name,
    modelId: model.id,
    agentId: resolved.identity.agentId,
    close,
    cancelAll,
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
      const live = await open().snapshot(LiveDoc, conversation.id, CONTEXT);
      return {
        threadId: normalized,
        status: live?.run ? "active" : "idle",
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
    // Zing's context policy bounds model input; don't silently truncate the durable transcript a second time.
    outputLimits: { maxBytes: Number.MAX_SAFE_INTEGER, maxLines: Number.MAX_SAFE_INTEGER },
    // Typed so a renamed result field fails to compile: pi-durable ignores unknown fields, and its fields are optional.
    execute: async (input, api, context): Promise<ToolExecutionResult> => {
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
        output: [{ type: "text", text: result.text }],
        // Match JSONL serialization: omit undefined properties and apply toJSON (for example Date).
        details: JSON.parse(JSON.stringify(result.details ?? null)) as JsonValue,
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
    getModel: (provider, id) => (provider === model.provider && id === model.id ? model : base.getModel(provider, id)),
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
  metadata: TurnRecord,
): Promise<void> {
  const { senderId, requestId } = metadata;
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
    turn.turns.push(metadata);
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

function findTurn<T extends TurnRecord>(
  turns: T[] | readonly T[] | undefined,
  requestId: string | undefined,
): T | undefined {
  return requestId === undefined ? undefined : turns?.find((turn) => turn.requestId === requestId);
}

/** Drop the turns observers have handled. */
function pruneTurns(turns: TurnRecord[]): void {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.observed) turns.splice(index, 1);
  }
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
    if (
      record.reason === "faulted" &&
      typeof record.detail === "string" &&
      record.detail.startsWith(BUDGET_FAILURE_PREFIX)
    ) {
      throw budgetError(JSON.parse(record.detail.slice(BUDGET_FAILURE_PREFIX.length)) as TurnFailure);
    }
    if (record.reason === "model_error") {
      throw new Error(typeof record.detail === "string" && record.detail ? record.detail : "model error");
    }
    throw new Error(`Turn was not answered: ${record.reason}`);
  }
  throw new Error(`Turn ended in unexpected state: ${record.status}`);
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

async function waitForSignal(signal: AbortSignal | undefined): Promise<void> {
  if (!signal || signal.aborted) return;
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve) => {
      onAbort = () => resolve();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  } finally {
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
