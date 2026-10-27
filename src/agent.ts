import { randomUUID } from "node:crypto";

import {
  Agent as PiAgent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { contentText, type JsonValue } from "@earendil-works/pi-ai";

import type { AgentLimits, Blueprint } from "./blueprint";
import { createMemoryCapsule, type Capsule } from "./capsule";
import { createContextWindowPolicy, type ContextWindowPolicy } from "./context";
import type {
  AgentResult,
  Approver,
  CapsuleRef,
  ConversationEvent,
  ConversationHost,
  ConversationListener,
  IncomingMessage,
  Tool,
} from "./plugin/types";
import {
  RuntimeError,
  TurnBudgetExceededError,
  TurnCanceledError,
  type AgentRuntime,
  type ListThreadsOptions,
  type RuntimeEvent,
  type ThreadEntry,
  type ThreadPage,
  type ThreadSnapshot,
  type TurnHandle,
  type TurnInput,
} from "./runtime";
import { composeSystemPrompt } from "./prompt";
import { withSkillTool, type Skill } from "./skills";
import type { Station } from "./station";
import { withSubagentTool, type Subagent, type SubagentRun } from "./subagents";
import { encodeMessages, type TranscriptEvent } from "./transcript";

export const DEFAULT_SYSTEM =
  "You are a helpful, concise assistant. Reply in the user's language.";
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  turnTimeoutMs: 300_000,
  maxModelTurns: 16,
  maxToolCalls: 32,
};

export const OBSERVER_TIMEOUT_MS = 5_000;

export type { AgentLimits, Blueprint } from "./blueprint";
export type { Capsule, CapsuleIdentity } from "./capsule";
export type { Station } from "./station";
export type { AgentResult, ConversationHost, IncomingMessage } from "./plugin/types";
export type {
  AgentRuntime,
  RuntimeEvent,
  ThreadEntry,
  ThreadPage,
  ThreadSnapshot,
  TurnHandle,
  TurnInput,
} from "./runtime";

export type Agent = ConversationHost &
  AgentRuntime & {
    name: string;
    modelId: string;
    agentId: string;
    close: () => Promise<void>;
    /** Stop taking turns and cancel every queued and running one; close() still releases the agent afterwards. */
    cancelAll: () => Promise<void>;
    drainObservers: () => Promise<void>;
  };

export type CreateAgentOptions = {
  tools?: readonly Tool[];
  /** Skills the blueprint lists, loaded. They add a prompt section and the skill tool. */
  skills?: readonly Skill[];
  /** Subagents the blueprint lists, loaded. They add a prompt section and the subagent tool. */
  subagents?: readonly Subagent[];
  limits?: Partial<AgentLimits>;
  listeners?: readonly ConversationListener[];
  observerTimeoutMs?: number;
};

export function createAgent(
  station: Station,
  blueprint: Blueprint,
  capsule?: Capsule,
  options?: CreateAgentOptions,
): Agent {
  if (blueprint.model === undefined) {
    throw new Error(`Blueprint ${blueprint.name} has no model. Set model in agent.yaml or MODEL=<id>.`);
  }
  const resolved = capsule ?? createMemoryCapsule({ blueprintName: blueprint.name });
  const model = station.resolveModel(blueprint.model);
  const skills = options?.skills ?? [];
  const subagents = options?.subagents ?? [];
  const system = composeSystemPrompt(blueprint.system ?? DEFAULT_SYSTEM, skills, subagents);
  const tools = withBuiltinTools(station, model.id, options?.tools ?? [], skills, subagents);
  const limits = resolveAgentLimits(blueprint.limits, options?.limits);
  const conversations = new Map<string, Conversation>();
  const pending = new Map<string, Promise<void>>();
  const active = new Map<string, ActiveTurn>();
  const capsuleRef: CapsuleRef = { agentId: resolved.identity.agentId, state: resolved.state };
  const observers = createObserverQueue(options?.listeners ?? [], options?.observerTimeoutMs ?? OBSERVER_TIMEOUT_MS);
  let closed = false;
  let closing: Promise<void> | undefined;

  const ensureOpen = (): void => {
    if (closed) {
      throw new RuntimeError("RUNTIME_CLOSED", "Agent is shutting down");
    }
  };

  const getConversation = async (threadId: string): Promise<Conversation> => {
    let conversation = conversations.get(threadId);
    if (!conversation) {
      await resolved.ensureConversation(threadId);
      conversation = new Conversation({
        station,
        modelId: model.id,
        tools,
        limits,
        system,
        capsule: capsuleRef,
        conversationId: threadId,
        messages: await resolved.loadConversation(threadId),
        persist: (fresh) => resolved.appendConversation(threadId, fresh),
      });
      conversations.set(threadId, conversation);
    }
    return conversation;
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
      if (pending.get(threadId) === tail) {
        pending.delete(threadId);
      }
    });
    return result;
  };

  const cancelTurn = async (threadId: string, turnId: string): Promise<void> => {
    const normalized = normalizeThreadId(threadId);
    const current = active.get(normalized);
    if (!current || current.turnId !== turnId) {
      throw new RuntimeError("TURN_NOT_ACTIVE", `Turn is not active: ${turnId}`);
    }
    current.canceled = true;
    current.conversation.abort();
  };

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
        current.conversation.abort();
      }
    });

    void enqueue(threadId, async () => {
      let current: ActiveTurn | undefined;
      let deadline: NodeJS.Timeout | undefined;
      let persisted: AgentMessage[] = [];
      const notifyTurn = (status: "completed" | "failed" | "canceled"): void => {
        if (persisted.length === 0) return;
        observers.notify({
          type: "turn",
          conversationId: threadId,
          senderId: input.senderId,
          capsule: capsuleRef,
          status,
          entries: encodeMessages(persisted).map(toThreadEntry),
        });
      };
      try {
        if (closed || cancelRequested) {
          throw new TurnCanceledError();
        }
        const conversation = await getConversation(threadId);
        if (closed || cancelRequested) {
          throw new TurnCanceledError();
        }
        current = { turnId, conversation, canceled: false };
        active.set(threadId, current);
        deadline = setTimeout(() => {
          if (current?.canceled) {
            return;
          }
          conversation.abort(
            new TurnBudgetExceededError("timeout", `Turn exceeded the ${limits.turnTimeoutMs}ms timeout`),
          );
        }, limits.turnTimeoutMs);
        deadline.unref();
        controller.emit({ type: "turn/started", threadId, turnId });
        const result = await conversation.prompt(
          input.text,
          input.senderId,
          input.approve,
          createRuntimeEventCollector(threadId, turnId, controller.emit),
          (fresh) => { persisted = fresh; },
        );
        if (current.canceled) {
          throw new TurnCanceledError();
        }
        notifyTurn("completed");
        controller.emit({ type: "turn/completed", threadId, turnId, status: "completed", result });
        controller.resolve(result);
      } catch (error) {
        const canceled =
          !(error instanceof TurnBudgetExceededError) &&
          (current?.canceled === true || error instanceof TurnCanceledError);
        if (canceled) {
          const canceledError = error instanceof TurnCanceledError ? error : new TurnCanceledError();
          notifyTurn("canceled");
          controller.emit({ type: "turn/completed", threadId, turnId, status: "canceled" });
          controller.reject(canceledError);
          return;
        }
        const failed = toError(error);
        notifyTurn("failed");
        controller.emit({
          type: "turn/completed",
          threadId,
          turnId,
          status: "failed",
          error: { message: failed.message },
        });
        controller.reject(failed);
      } finally {
        if (deadline) {
          clearTimeout(deadline);
        }
        if (active.get(threadId)?.turnId === turnId) {
          active.delete(threadId);
        }
      }
    });

    return controller.handle;
  };

  const resetThread = (threadId: string): Promise<void> => {
    ensureOpen();
    const normalized = normalizeThreadId(threadId);
    return enqueue(normalized, async () => {
      conversations.delete(normalized);
      await resolved.resetConversation(normalized);
      observers.notify({ type: "reset", conversationId: normalized, capsule: capsuleRef });
    });
  };

  const cancelAll = async (): Promise<void> => {
    closed = true;
    for (const current of active.values()) {
      current.canceled = true;
      current.conversation.abort();
    }
  };

  const close = (): Promise<void> => {
    closed = true;
    closing ??= (async () => {
      await cancelAll();
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
    cancelAll,
    async drainObservers() {
      await observers.drain();
    },
    async handleMessage(message: IncomingMessage) {
      return startTurn({
        threadId: message.conversationId,
        text: message.text,
        senderId: message.senderId,
        approve: message.approve,
      }).completed;
    },
    resetConversation: resetThread,
    async openThread(threadId) {
      ensureOpen();
      const normalized = normalizeThreadId(threadId ?? createRuntimeId("thr"));
      const { created } = await resolved.ensureConversation(normalized);
      return { threadId: normalized, created };
    },
    async readThread(threadId) {
      const normalized = normalizeThreadId(threadId);
      const events = await resolved.readConversationEvents(normalized);
      if (!events) {
        throw new RuntimeError("THREAD_NOT_FOUND", `Thread not found: ${normalized}`);
      }
      return {
        threadId: normalized,
        status: active.has(normalized) ? "active" : "idle",
        entries: events.map(toThreadEntry),
      };
    },
    async listThreads(options?: ListThreadsOptions) {
      const conversations = await resolved.listConversations();
      conversations.sort(
        (left, right) => right.updatedAt - left.updatedAt || left.conversationId.localeCompare(right.conversationId),
      );
      const offset = decodeCursor(options?.cursor);
      const limit = normalizeLimit(options?.limit);
      const data = conversations.slice(offset, offset + limit).map((conversation) => ({
        threadId: conversation.conversationId,
        updatedAt: conversation.updatedAt,
      }));
      const nextOffset = offset + data.length;
      return {
        data,
        nextCursor: nextOffset < conversations.length ? encodeCursor(nextOffset) : null,
      };
    },
    startTurn,
    cancelTurn,
    resetThread,
  };
}

type ActiveTurn = {
  turnId: string;
  conversation: Conversation;
  canceled: boolean;
};

type ConversationOptions = {
  station: Station;
  modelId: string;
  tools: readonly Tool[];
  limits: AgentLimits;
  system: string;
  capsule: CapsuleRef;
  conversationId: string;
  messages: AgentMessage[];
  /** Store the messages a prompt added. Absent: they live only in memory, as a subagent's do. */
  persist?: (fresh: AgentMessage[]) => Promise<void>;
};

type ActiveBudget = {
  modelTurns: number;
  toolCalls: number;
  failure?: TurnBudgetExceededError;
};

class Conversation {
  private readonly inner: PiAgent;
  private readonly persist?: (fresh: AgentMessage[]) => Promise<void>;
  private readonly limits: AgentLimits;
  private readonly context: ContextWindowPolicy;
  private senderId?: string;
  private approve?: Approver;
  private activeBudget?: ActiveBudget;
  private abortFailure?: TurnBudgetExceededError;
  private persisted: number;

  constructor(options: ConversationOptions) {
    this.persist = options.persist;
    this.limits = options.limits;
    const model = options.station.resolveModel(options.modelId);
    const tools = options.tools.map((tool) =>
      createAgentTool(tool, {
        conversationId: options.conversationId,
        senderId: () => this.senderId,
        approve: () => this.approve,
        capsule: options.capsule,
      }),
    ).map(createAbortableAgentTool);
    this.context = createContextWindowPolicy(model, options.system, tools);
    this.inner = new PiAgent({
      initialState: {
        systemPrompt: options.system,
        model,
        tools,
        messages: options.messages,
      },
      streamFn: options.station.streamFn,
      getApiKey: options.station.getApiKey,
      transformContext: async (messages) => this.context.fit(messages),
      beforeToolCall: async () => {
        const budget = this.activeBudget;
        if (!budget) {
          return undefined;
        }
        if (budget.toolCalls >= this.limits.maxToolCalls) {
          budget.failure ??= new TurnBudgetExceededError(
            "tool-calls",
            `Turn exceeded the ${this.limits.maxToolCalls} tool-call limit`,
          );
          return { block: true, reason: budget.failure.message, terminate: true };
        }
        budget.toolCalls += 1;
        return undefined;
      },
      finishTurn: ({ message, context }) => {
        const budget = this.activeBudget;
        // Error and aborted responses end the run regardless; they do not count as model turns.
        if (!budget || message.stopReason === "error" || message.stopReason === "aborted") {
          return undefined;
        }
        budget.modelTurns += 1;
        if (budget.failure) {
          return { action: "end" };
        }
        const continues = message.content.some((block) => block.type === "toolCall");
        if (continues && budget.modelTurns >= this.limits.maxModelTurns) {
          budget.failure = new TurnBudgetExceededError(
            "model-turns",
            `Turn exceeded the ${this.limits.maxModelTurns} model-turn limit`,
          );
          return { action: "end" };
        }
        if (continues && !this.context.currentTurnFits(context.messages)) {
          budget.failure = new TurnBudgetExceededError(
            "context",
            `Current turn exceeded its ${this.context.messageBudget}-token context budget`,
          );
          return { action: "end" };
        }
        return undefined;
      },
    });
    // pi-agent-core prepends the system prompt as a system message; the capsule stores only what follows it.
    this.persisted = this.inner.state.messages.length;
  }

  abort(failure?: TurnBudgetExceededError): void {
    if (failure) {
      this.abortFailure ??= failure;
    }
    this.inner.abort();
  }

  async prompt(
    message: string,
    senderId?: string,
    approve?: Approver,
    onEvent?: (event: AgentEvent) => void,
    onPersisted?: (fresh: AgentMessage[]) => void,
  ): Promise<AgentResult> {
    this.senderId = senderId;
    this.approve = approve;
    const budget: ActiveBudget = { modelTurns: 0, toolCalls: 0 };
    this.activeBudget = budget;
    this.abortFailure = undefined;
    const unsubscribe = this.inner.subscribe((event) => onEvent?.(event));

    let runError: unknown;
    try {
      if (!this.context.userInputFits(message, this.inner.state.messages.some((entry) => entry.role !== "system"))) {
        throw new TurnBudgetExceededError(
          "context",
          `User input exceeded its ${this.context.messageBudget}-token context budget`,
        );
      }
      await this.inner.prompt(message);
    } catch (error) {
      runError = error;
    } finally {
      unsubscribe();
      try {
        const messages = this.inner.state.messages;
        const fresh = messages.slice(this.persisted);
        if (fresh.length > 0) {
          await this.persist?.(fresh);
          this.persisted = messages.length;
          onPersisted?.(fresh);
        }
      } finally {
        this.activeBudget = undefined;
      }
    }

    const enforcedFailure = this.abortFailure ?? budget.failure;
    this.abortFailure = undefined;
    if (enforcedFailure) {
      throw enforcedFailure;
    }
    if (runError) {
      throw runError;
    }

    const last = lastAssistantMessage(this.inner.state.messages);
    if (last?.stopReason === "aborted") {
      throw new TurnCanceledError();
    }
    if (last?.stopReason === "error") {
      throw new Error(last.errorMessage ?? "model error");
    }

    return { text: last ? contentText(last.content).trim() : "" };
  }
}

/**
 * The tools a runtime offers: the plugins' tools, then the skill tool when there are skills, then the subagent tool
 * when there are subagents. Each subagent's model resolves here, so an unknown model fails startup.
 */
export function withBuiltinTools(
  station: Station,
  modelId: string,
  tools: readonly Tool[],
  skills: readonly Skill[],
  subagents: readonly Subagent[],
): Tool[] {
  return withSubagentTool(withSkillTool(tools, skills), subagents, createSubagentRunner(station, modelId, tools, subagents));
}

/**
 * Runs a subagent inside the tool call that delegated to it: a fresh conversation with its own instructions, model,
 * tools, and limits, which never reaches the capsule's threads or conversation observers. Its tools see the calling
 * turn's conversation and sender, and the calling turn's cancellation and deadline stop it.
 */
function createSubagentRunner(
  station: Station,
  modelId: string,
  tools: readonly Tool[],
  subagents: readonly Subagent[],
): SubagentRun {
  const available = new Map(tools.map((tool) => [tool.name, tool]));
  const prepared = new Map(
    subagents.map(({ blueprint, skills }) => {
      const own = blueprint.tools.map((name) => {
        const tool = available.get(name);
        if (!tool) throw new Error(`Subagent ${blueprint.name} lists tool ${name}, which the main agent does not have`);
        return tool;
      });
      return [
        blueprint.name,
        {
          modelId: station.resolveModel(blueprint.model ?? modelId).id,
          system: composeSystemPrompt(blueprint.system, skills),
          tools: withSkillTool(own, skills),
          limits: resolveAgentLimits(blueprint.limits, undefined),
        },
      ] as const;
    }),
  );

  return async ({ blueprint }, task, context) => {
    const setup = prepared.get(blueprint.name);
    if (!setup) throw new Error(`Unknown subagent: ${blueprint.name}`);
    context.signal.throwIfAborted();
    const conversation = new Conversation({
      station,
      ...setup,
      capsule: context.capsule,
      conversationId: context.conversationId,
      messages: [],
    });
    const cancel = () => conversation.abort();
    context.signal.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(() => {
      conversation.abort(
        new TurnBudgetExceededError("timeout", `Turn exceeded the ${setup.limits.turnTimeoutMs}ms timeout`),
      );
    }, setup.limits.turnTimeoutMs);
    deadline.unref();
    let entries: ThreadEntry[] = [];
    try {
      const result = await conversation.prompt(task, context.senderId, context.approve, undefined, (fresh) => {
        entries = encodeMessages(fresh).map(toThreadEntry);
      });
      // Thread entries are JSON: the capsule stores them the same way.
      return { text: result.text, details: { subagent: blueprint.name, entries } as unknown as JsonValue };
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw new Error(`Subagent ${blueprint.name} failed: ${toError(error).message}`, { cause: error });
    } finally {
      clearTimeout(deadline);
      context.signal.removeEventListener("abort", cancel);
    }
  };
}

type ToolScope = {
  conversationId: string;
  senderId: () => string | undefined;
  approve: () => Approver | undefined;
  capsule: CapsuleRef;
};

function createAgentTool(tool: Tool, scope: ToolScope): AgentTool {
  return {
    label: tool.name,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, input, signal) => {
      const approve = scope.approve();
      const result = await tool.execute(input as Record<string, unknown>, {
        signal: signal ?? new AbortController().signal,
        conversationId: scope.conversationId,
        senderId: scope.senderId(),
        capsule: scope.capsule,
        ...(approve ? { approve } : {}),
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details ?? null,
      };
    },
  };
}

function createAbortableAgentTool(tool: AgentTool): AgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const work = Promise.resolve(tool.execute(toolCallId, params, signal, onUpdate));
      return raceWithAbort(work, signal, `${tool.name} aborted`);
    },
  };
}

export function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(new Error(message));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      void work.catch(() => undefined);
      reject(new Error(message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export type TurnController = {
  handle: TurnHandle;
  emit: (event: RuntimeEvent) => void;
  resolve: (result: AgentResult) => void;
  reject: (error: Error) => void;
};

export function createTurnController(turnId: string, cancel: () => void): TurnController {
  const listeners = new Set<(event: RuntimeEvent) => void>();
  let resolve!: (result: AgentResult) => void;
  let reject!: (error: Error) => void;
  const completed = new Promise<AgentResult>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  void completed.catch(() => undefined);

  return {
    handle: {
      turnId,
      completed,
      cancel,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          console.warn("runtime event listener failed", error);
        }
      }
    },
    resolve,
    reject,
  };
}

function createRuntimeEventCollector(
  threadId: string,
  turnId: string,
  emit: (event: RuntimeEvent) => void,
): (event: AgentEvent) => void {
  let messageId: string | undefined;
  let messageHasText = false;

  return (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      messageId ??= createRuntimeId("msg");
      messageHasText = true;
      emit({
        type: "message/delta",
        threadId,
        turnId,
        messageId,
        delta: event.assistantMessageEvent.delta,
      });
      return;
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const text = contentText(event.message.content);
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
      const details: unknown = event.isError ? undefined : event.result?.details;
      emit({
        type: "tool/completed",
        threadId,
        turnId,
        callId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
        ...(details !== undefined && details !== null ? { details } : {}),
      });
    }
  };
}

export type ObserverQueue = {
  /** Settles once every listener has handled, failed, or timed out on this event; it never rejects. */
  notify: (event: ConversationEvent) => Promise<void>;
  drain: () => Promise<void>;
};

export function createObserverQueue(
  listeners: readonly ConversationListener[],
  timeoutMs: number,
): ObserverQueue {
  const tails = new Map<ConversationListener, Promise<void>>();

  return {
    notify(event) {
      const handled: Promise<void>[] = [];
      for (const listener of listeners) {
        const previous = tails.get(listener) ?? Promise.resolve();
        const tail = previous.then(() => runConversationListener(listener, event, timeoutMs));
        tails.set(listener, tail);
        handled.push(tail);
        void tail.finally(() => {
          if (tails.get(listener) === tail) tails.delete(listener);
        });
      }
      return Promise.all(handled).then(() => undefined);
    },
    async drain() {
      while (tails.size > 0) {
        const current = [...tails.values()];
        await Promise.all(current);
        if (current.every((tail) => ![...tails.values()].includes(tail))) continue;
      }
    },
  };
}

async function runConversationListener(
  listener: ConversationListener,
  event: ConversationEvent,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const work = Promise.resolve().then(() => listener(event, controller.signal));
  void work.catch(() => undefined);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`conversation listener timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([work, timeout]);
  } catch (error) {
    console.warn(`conversation listener failed (${event.type} ${event.conversationId})`, error);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function lastAssistantMessage(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

export function normalizeThreadId(value: string): string {
  const threadId = value.trim();
  if (
    !threadId ||
    Buffer.byteLength(threadId, "utf8") > 80 ||
    /[\u0000-\u001f\u007f]/.test(threadId)
  ) {
    throw new RuntimeError("INVALID_THREAD_ID", "Thread id must be 1-80 UTF-8 bytes without control characters");
  }
  return threadId;
}

export function createRuntimeId(prefix: "msg" | "thr" | "turn"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new RuntimeError("INVALID_CURSOR", "Invalid thread list cursor");
  }
  if (!/^(0|[1-9][0-9]*)$/.test(decoded)) {
    throw new RuntimeError("INVALID_CURSOR", "Invalid thread list cursor");
  }
  const offset = Number(decoded);
  if (!Number.isSafeInteger(offset)) {
    throw new RuntimeError("INVALID_CURSOR", "Invalid thread list cursor");
  }
  return offset;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RuntimeError("INVALID_LIST_OPTIONS", "Thread list limit must be a positive integer");
  }
  return Math.min(limit, 100);
}

export function toThreadEntry(event: TranscriptEvent): ThreadEntry {
  if (event.type === "reset") {
    throw new Error("Reset marker cannot be exposed as a thread entry");
  }
  if (event.type === "user") {
    return { type: "user", at: event.at, content: event.content };
  }
  if (event.type === "assistant") {
    return {
      type: "assistant",
      at: event.at,
      model: event.model,
      stopReason: event.stopReason,
      errorMessage: event.errorMessage,
      content: event.content,
    };
  }
  return {
    type: "toolResult",
    at: event.at,
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    isError: event.isError,
    content: event.content,
    details: event.details,
  };
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function resolveAgentLimits(
  blueprint: Partial<AgentLimits> | undefined,
  overrides: Partial<AgentLimits> | undefined,
): AgentLimits {
  const limits = { ...DEFAULT_AGENT_LIMITS };
  for (const source of [blueprint, overrides]) {
    for (const [name, value] of Object.entries(source ?? {})) {
      if (value !== undefined) {
        limits[name as keyof AgentLimits] = value;
      }
    }
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  return limits;
}
