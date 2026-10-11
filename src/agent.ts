import { randomUUID } from "node:crypto";

import {
  Agent as PiAgent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";

import type { AgentLimits, Blueprint } from "./blueprint";
import { createMemoryCapsule, type Capsule } from "./capsule";
import { createContextWindowPolicy, type ContextWindowPolicy } from "./context";
import type {
  AgentResult,
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
import type { Station } from "./station";
import { encodeMessages, type TranscriptEvent } from "./transcript";

export const DEFAULT_MODEL = "grok-4.6";
export const DEFAULT_SYSTEM =
  "You are a helpful, concise assistant. Reply in the user's language.";
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  turnTimeoutMs: 300_000,
  maxModelTurns: 16,
  maxToolCalls: 32,
};

const OBSERVER_TIMEOUT_MS = 5_000;

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
    drainObservers: () => Promise<void>;
  };

export type CreateAgentOptions = {
  tools?: readonly Tool[];
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
  const resolved = capsule ?? createMemoryCapsule({ blueprintName: blueprint.name });
  const model = station.resolveModel(blueprint.model ?? DEFAULT_MODEL);
  const system = blueprint.system ?? DEFAULT_SYSTEM;
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
        tools: options?.tools ?? [],
        limits,
        system,
        capsule: resolved,
        conversationId: threadId,
        messages: await resolved.loadConversation(threadId),
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

  const close = (): Promise<void> => {
    closed = true;
    closing ??= (async () => {
      for (const current of active.values()) {
        current.canceled = true;
        current.conversation.abort();
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
  capsule: Capsule;
  conversationId: string;
  messages: AgentMessage[];
};

type ActiveBudget = {
  modelTurns: number;
  toolCalls: number;
  failure?: TurnBudgetExceededError;
};

class Conversation {
  private readonly inner: PiAgent;
  private readonly capsule: Capsule;
  private readonly conversationId: string;
  private readonly limits: AgentLimits;
  private readonly context: ContextWindowPolicy;
  private senderId?: string;
  private activeBudget?: ActiveBudget;
  private abortFailure?: TurnBudgetExceededError;
  private persisted: number;

  constructor(options: ConversationOptions) {
    this.capsule = options.capsule;
    this.conversationId = options.conversationId;
    this.limits = options.limits;
    this.persisted = options.messages.length;
    const model = options.station.resolveModel(options.modelId);
    const tools = options.tools.map((tool) =>
      createAgentTool(tool, {
        conversationId: options.conversationId,
        senderId: () => this.senderId,
        capsule: {
          agentId: options.capsule.identity.agentId,
          state: options.capsule.state,
        },
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
      shouldStopAfterTurn: ({ message, context }) => {
        const budget = this.activeBudget;
        if (!budget) {
          return false;
        }
        budget.modelTurns += 1;
        if (budget.failure) {
          return true;
        }
        const continues = message.content.some((block) => block.type === "toolCall");
        if (continues && budget.modelTurns >= this.limits.maxModelTurns) {
          budget.failure = new TurnBudgetExceededError(
            "model-turns",
            `Turn exceeded the ${this.limits.maxModelTurns} model-turn limit`,
          );
          return true;
        }
        if (continues && !this.context.currentTurnFits(context.messages)) {
          budget.failure = new TurnBudgetExceededError(
            "context",
            `Current turn exceeded its ${this.context.messageBudget}-token context budget`,
          );
          return true;
        }
        return false;
      },
    });
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
    onEvent?: (event: AgentEvent) => void,
    onPersisted?: (fresh: AgentMessage[]) => void,
  ): Promise<AgentResult> {
    this.senderId = senderId;
    const budget: ActiveBudget = { modelTurns: 0, toolCalls: 0 };
    this.activeBudget = budget;
    this.abortFailure = undefined;
    const unsubscribe = this.inner.subscribe((event) => onEvent?.(event));

    let runError: unknown;
    try {
      if (!this.context.userInputFits(message, this.inner.state.messages.length > 0)) {
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
          await this.capsule.appendConversation(this.conversationId, fresh);
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

type ToolScope = {
  conversationId: string;
  senderId: () => string | undefined;
  capsule: CapsuleRef;
};

function createAgentTool(tool: Tool, scope: ToolScope): AgentTool {
  return {
    label: tool.name,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    execute: async (_toolCallId, input, signal) => {
      const result = await tool.execute(input as Record<string, unknown>, {
        signal: signal ?? new AbortController().signal,
        conversationId: scope.conversationId,
        senderId: scope.senderId(),
        capsule: scope.capsule,
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

function raceWithAbort<T>(work: Promise<T>, signal: AbortSignal | undefined, message: string): Promise<T> {
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

type TurnController = {
  handle: TurnHandle;
  emit: (event: RuntimeEvent) => void;
  resolve: (result: AgentResult) => void;
  reject: (error: Error) => void;
};

function createTurnController(turnId: string, cancel: () => void): TurnController {
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
      emit({
        type: "tool/completed",
        threadId,
        turnId,
        callId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
      });
    }
  };
}

type ObserverQueue = {
  notify: (event: ConversationEvent) => void;
  drain: () => Promise<void>;
};

function createObserverQueue(
  listeners: readonly ConversationListener[],
  timeoutMs: number,
): ObserverQueue {
  const tails = new Map<ConversationListener, Promise<void>>();

  return {
    notify(event) {
      for (const listener of listeners) {
        const previous = tails.get(listener) ?? Promise.resolve();
        const tail = previous.then(() => runConversationListener(listener, event, timeoutMs));
        tails.set(listener, tail);
        void tail.finally(() => {
          if (tails.get(listener) === tail) tails.delete(listener);
        });
      }
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

function normalizeThreadId(value: string): string {
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

function createRuntimeId(prefix: "msg" | "thr" | "turn"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function decodeCursor(cursor: string | undefined): number {
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

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), "utf8").toString("base64url");
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RuntimeError("INVALID_LIST_OPTIONS", "Thread list limit must be a positive integer");
  }
  return Math.min(limit, 100);
}

function toThreadEntry(event: TranscriptEvent): ThreadEntry {
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

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resolveAgentLimits(
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
