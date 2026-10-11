import type { AgentResult } from "./plugin/types";

export const PROTOCOL_VERSION = 1;

export type ThreadId = string;
export type TurnId = string;

export type ThreadTextContent = { type: "text"; text: string };
export type ThreadImageContent = { type: "image"; data: string; mimeType: string };
export type ThreadThinkingContent = { type: "thinking"; thinking: string };
export type ThreadToolCallContent = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ThreadEntry =
  | {
      type: "user";
      at: number;
      content: string | Array<ThreadTextContent | ThreadImageContent>;
    }
  | {
      type: "assistant";
      at: number;
      model?: string;
      stopReason?: string;
      errorMessage?: string;
      content: Array<ThreadTextContent | ThreadThinkingContent | ThreadToolCallContent>;
    }
  | {
      type: "toolResult";
      at: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content: Array<ThreadTextContent | ThreadImageContent>;
      details?: unknown;
    };

export type ThreadSnapshot = {
  threadId: ThreadId;
  status: "idle" | "active";
  entries: ThreadEntry[];
};

export type ThreadSummary = {
  threadId: ThreadId;
  updatedAt: number;
};

export type ListThreadsOptions = {
  cursor?: string;
  limit?: number;
};

export type ThreadPage = {
  data: ThreadSummary[];
  nextCursor: string | null;
};

export type TurnInput = {
  threadId: ThreadId;
  text: string;
  senderId?: string;
  /**
   * Client deduplication key, scoped to the thread. The durable runtime answers a repeated key with the original
   * turn's outcome instead of running it again; the legacy runtime ignores it.
   */
  requestId?: string;
};

export type RuntimeEvent =
  | { type: "turn/started"; threadId: ThreadId; turnId: TurnId }
  | {
      type: "message/delta";
      threadId: ThreadId;
      turnId: TurnId;
      messageId: string;
      delta: string;
    }
  | {
      type: "message/completed";
      threadId: ThreadId;
      turnId: TurnId;
      messageId: string;
      text: string;
    }
  | {
      type: "tool/started";
      threadId: ThreadId;
      turnId: TurnId;
      callId: string;
      name: string;
      input?: unknown;
    }
  | {
      type: "tool/completed";
      threadId: ThreadId;
      turnId: TurnId;
      callId: string;
      name: string;
      isError: boolean;
    }
  | {
      type: "turn/completed";
      threadId: ThreadId;
      turnId: TurnId;
      status: "completed" | "failed" | "canceled";
      result?: AgentResult;
      error?: { message: string };
    };

export type TurnHandle = {
  readonly turnId: TurnId;
  readonly completed: Promise<AgentResult>;
  /** Cancel this turn whether it is queued or active. */
  cancel: () => void;
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
};

export type AgentRuntime = {
  openThread: (threadId?: ThreadId) => Promise<{ threadId: ThreadId; created: boolean }>;
  readThread: (threadId: ThreadId) => Promise<ThreadSnapshot>;
  listThreads: (options?: ListThreadsOptions) => Promise<ThreadPage>;
  startTurn: (input: TurnInput) => TurnHandle;
  cancelTurn: (threadId: ThreadId, turnId: TurnId) => Promise<void>;
  resetThread: (threadId: ThreadId) => Promise<void>;
};

export type RuntimeErrorCode =
  | "INVALID_CURSOR"
  | "INVALID_LIST_OPTIONS"
  | "INVALID_THREAD_ID"
  | "RUNTIME_CLOSED"
  | "THREAD_NOT_FOUND"
  | "TURN_NOT_ACTIVE";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export class TurnCanceledError extends Error {
  constructor() {
    super("Turn canceled");
    this.name = "TurnCanceledError";
  }
}

export type TurnBudget = "context" | "model-turns" | "timeout" | "tool-calls";

export class TurnBudgetExceededError extends Error {
  readonly budget: TurnBudget;

  constructor(budget: TurnBudget, message: string) {
    super(message);
    this.name = "TurnBudgetExceededError";
    this.budget = budget;
  }
}
