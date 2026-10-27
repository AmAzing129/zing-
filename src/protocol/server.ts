import { randomUUID } from "node:crypto";

import type { Approver, ClientMethod } from "../plugin/types";
import type { AgentRuntime, TurnHandle } from "../runtime";
import { PROTOCOL_VERSION, RuntimeError } from "../runtime";
import type {
  AppServerInfo,
  JsonRpcError,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcSuccess,
} from "./types";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const NOT_INITIALIZED = -32001;
const ALREADY_INITIALIZED = -32002;
const UNSUPPORTED_VERSION = -32003;
const THREAD_NOT_FOUND = -32010;
const TURN_NOT_ACTIVE = -32011;
const APPROVAL_NOT_PENDING = -32012;
const METHOD_FAILED = -32020;

type DispatchResult = {
  result: unknown;
  afterResponse?: () => void;
};

type TrackedTurn = {
  completed: Promise<unknown>;
  cancel: () => void;
};

type Notification = { method: string; params: unknown };

export type ProtocolSessionOptions = {
  runtime: AgentRuntime;
  info: AppServerInfo;
  write: (message: JsonRpcMessage) => void | Promise<void>;
  /** Methods plugins offer clients, routed by name. */
  methods?: readonly ClientMethod[];
  onError?: (error: unknown) => void;
};

export class ProtocolSession {
  private readonly runtime: AgentRuntime;
  private readonly info: AppServerInfo;
  private readonly write: ProtocolSessionOptions["write"];
  private readonly onError: (error: unknown) => void;
  private readonly methods: ReadonlyMap<string, ClientMethod>;
  /** Aborts plugin method calls when the connection closes. */
  private readonly closing = new AbortController();
  private readonly turns = new Map<string, TrackedTurn>();
  /** Approvals this connection's turns wait for, by approvalId. */
  private readonly approvals = new Map<string, (approved: boolean) => void>();
  private initialized = false;
  /** The client declared it answers approval/requested. */
  private answersApprovals = false;
  private writeTail = Promise.resolve();

  constructor(options: ProtocolSessionOptions) {
    this.runtime = options.runtime;
    this.info = options.info;
    this.write = options.write;
    this.methods = new Map((options.methods ?? []).map((method) => [method.name, method]));
    this.onError = options.onError ?? ((error) => console.error("app-server error", error));
  }

  async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      await this.sendError(null, PARSE_ERROR, "Parse error");
      return;
    }
    await this.handleMessage(raw);
  }

  async handleMessage(raw: unknown): Promise<void> {
    let request: JsonRpcRequest;
    try {
      request = parseRequest(raw);
    } catch (error) {
      const failure = protocolError(error);
      await this.sendError(null, failure.code, failure.message, failure.data);
      return;
    }

    try {
      const dispatched = await this.dispatch(request.method, request.params);
      await this.sendSuccess(request.id, dispatched.result);
      dispatched.afterResponse?.();
    } catch (error) {
      const failure = protocolError(error);
      if (failure.code === INTERNAL_ERROR) {
        this.onError(error);
      }
      await this.sendError(request.id, failure.code, failure.message, failure.data);
    }
  }

  async close(): Promise<void> {
    this.closing.abort();
    for (const answer of [...this.approvals.values()]) answer(false);
    const turns = [...this.turns.values()];
    for (const turn of turns) {
      turn.cancel();
    }
    await Promise.allSettled(turns.map((turn) => turn.completed));
    this.turns.clear();
    await this.writeTail;
  }

  private async dispatch(method: string, params: unknown): Promise<DispatchResult> {
    if (method === "initialize") {
      if (this.initialized) {
        throw new ProtocolError(ALREADY_INITIALIZED, "Already initialized");
      }
      const record = requiredRecord(params);
      const version = record.protocolVersion;
      if (version !== PROTOCOL_VERSION) {
        throw new ProtocolError(UNSUPPORTED_VERSION, `Unsupported protocol version: ${String(version)}`, {
          supported: [PROTOCOL_VERSION],
        });
      }
      const clientInfo = requiredRecord(record.clientInfo);
      requiredNonEmptyString(clientInfo.name, "clientInfo.name");
      requiredNonEmptyString(clientInfo.version, "clientInfo.version");
      const clientCapabilities = optionalRecord(record.capabilities);
      if (clientCapabilities.approvals !== undefined && typeof clientCapabilities.approvals !== "boolean") {
        throw new ProtocolError(INVALID_PARAMS, "capabilities.approvals must be a boolean");
      }
      this.answersApprovals = clientCapabilities.approvals === true;
      this.initialized = true;
      return {
        result: {
          protocolVersion: PROTOCOL_VERSION,
          agent: this.info,
          capabilities: {
            streaming: true,
            cancel: true,
            threadRead: true,
            threadList: true,
            approvals: true,
            ...(this.methods.size > 0 ? { methods: [...this.methods.keys()] } : {}),
          },
        },
      };
    }

    if (!this.initialized) {
      throw new ProtocolError(NOT_INITIALIZED, "Not initialized");
    }

    if (method === "thread/open") {
      const record = optionalRecord(params);
      const threadId = optionalString(record.threadId, "threadId");
      return { result: { thread: await this.runtime.openThread(threadId) } };
    }
    if (method === "thread/read") {
      const record = requiredRecord(params);
      const threadId = requiredNonEmptyString(record.threadId, "threadId");
      return { result: { thread: await this.runtime.readThread(threadId) } };
    }
    if (method === "thread/list") {
      const record = optionalRecord(params);
      const cursor = optionalString(record.cursor, "cursor");
      const limit = optionalPositiveInteger(record.limit, "limit");
      return { result: await this.runtime.listThreads({ cursor, limit }) };
    }
    if (method === "thread/reset") {
      const record = requiredRecord(params);
      const threadId = requiredNonEmptyString(record.threadId, "threadId");
      await this.runtime.resetThread(threadId);
      return { result: {} };
    }
    if (method === "turn/start") {
      const record = requiredRecord(params);
      const threadId = requiredNonEmptyString(record.threadId, "threadId");
      const input = requiredRecord(record.input);
      if (input.type !== "text") {
        throw new ProtocolError(INVALID_PARAMS, "input.type must be text");
      }
      const text = requiredNonEmptyString(input.text, "input.text", false);
      const senderId = optionalString(record.senderId, "senderId");
      const outbox = this.openOutbox();
      let turnId: string | undefined;
      // A client that does not answer approvals gets none: calls that need one are declined, not left waiting.
      const approve: Approver | undefined = this.answersApprovals
        ? (request, signal) => this.requestApproval(threadId, () => turnId ?? "", request, signal, outbox.notify)
        : undefined;
      const handle = this.runtime.startTurn({ threadId, text, senderId, ...(approve ? { approve } : {}) });
      turnId = handle.turnId;
      return this.trackTurn(handle, outbox);
    }
    if (method === "approval/respond") {
      const record = requiredRecord(params);
      const approvalId = requiredNonEmptyString(record.approvalId, "approvalId");
      if (typeof record.approved !== "boolean") {
        throw new ProtocolError(INVALID_PARAMS, "approved must be a boolean");
      }
      const answer = this.approvals.get(approvalId);
      if (!answer) {
        throw new ProtocolError(APPROVAL_NOT_PENDING, `Approval is not pending: ${approvalId}`);
      }
      answer(record.approved);
      return { result: {} };
    }
    if (method === "turn/cancel") {
      const record = requiredRecord(params);
      const threadId = requiredNonEmptyString(record.threadId, "threadId");
      const turnId = requiredNonEmptyString(record.turnId, "turnId");
      await this.runtime.cancelTurn(threadId, turnId);
      return { result: {} };
    }

    const registered = this.methods.get(method);
    if (registered) {
      try {
        return { result: await registered.handle(params, { signal: this.closing.signal }) };
      } catch (error) {
        // The plugin's message is the answer: its client called a method the plugin defines.
        throw new ProtocolError(METHOD_FAILED, error instanceof Error ? error.message : String(error));
      }
    }

    throw new ProtocolError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }

  /** Ask the client, and wait for approval/respond or the end of the turn, which declines. */
  private async requestApproval(
    threadId: string,
    turnIdOf: () => string,
    request: Parameters<Approver>[0],
    signal: AbortSignal,
    notify: (notification: Notification) => void,
  ): Promise<boolean> {
    // A runtime may ask before startTurn has returned the turn's ID.
    await Promise.resolve();
    if (signal.aborted) return false;
    const turnId = turnIdOf();
    const approvalId = `apr_${randomUUID()}`;
    return new Promise((resolve) => {
      const answer = (approved: boolean): void => {
        if (!this.approvals.delete(approvalId)) return;
        signal.removeEventListener("abort", decline);
        resolve(approved);
      };
      const decline = (): void => answer(false);
      signal.addEventListener("abort", decline, { once: true });
      this.approvals.set(approvalId, answer);
      const params = { ...request, type: "approval/requested", threadId, turnId, approvalId };
      notify({ method: "approval/requested", params });
    });
  }

  /** Holds a turn's notifications until release: nothing about a turn precedes the turn/start response. */
  private openOutbox(): { notify: (notification: Notification) => void; release: () => void } {
    let ready = false;
    const buffered: Notification[] = [];
    return {
      notify: (notification) => {
        if (ready) void this.send({ jsonrpc: "2.0", ...notification });
        else buffered.push(notification);
      },
      release: () => {
        ready = true;
        for (const notification of buffered.splice(0)) void this.send({ jsonrpc: "2.0", ...notification });
      },
    };
  }

  private trackTurn(handle: TurnHandle, outbox: ReturnType<ProtocolSession["openOutbox"]>): DispatchResult {
    const unsubscribe = handle.subscribe((event) => outbox.notify({ method: event.type, params: event }));
    const completed = handle.completed
      .catch(() => undefined)
      .finally(() => {
        unsubscribe();
        this.turns.delete(handle.turnId);
      });
    this.turns.set(handle.turnId, { completed, cancel: handle.cancel });

    return { result: { turn: { id: handle.turnId, status: "queued" } }, afterResponse: outbox.release };
  }

  private sendSuccess(id: JsonRpcId, result: unknown): Promise<void> {
    const message: JsonRpcSuccess = { jsonrpc: "2.0", id, result };
    return this.send(message);
  }

  private sendError(id: JsonRpcId | null, code: number, message: string, data?: unknown): Promise<void> {
    const error = data === undefined ? { code, message } : { code, message, data };
    const response: JsonRpcError = { jsonrpc: "2.0", id, error };
    return this.send(response);
  }

  private send(message: JsonRpcMessage): Promise<void> {
    const writing = this.writeTail.then(() => this.write(message));
    this.writeTail = writing.catch((error) => {
      this.onError(error);
    });
    return writing;
  }
}

class ProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.data = data;
  }
}

function parseRequest(raw: unknown): JsonRpcRequest {
  if (!isRecord(raw) || raw.jsonrpc !== "2.0" || typeof raw.method !== "string" || !raw.method) {
    throw new ProtocolError(INVALID_REQUEST, "Invalid Request");
  }
  const id = raw.id;
  if (!isJsonRpcId(id)) {
    throw new ProtocolError(INVALID_REQUEST, "Invalid Request");
  }
  return { jsonrpc: "2.0", id, method: raw.method, params: raw.params };
}

function protocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) {
    return error;
  }
  if (error instanceof RuntimeError) {
    if (error.code === "THREAD_NOT_FOUND") {
      return new ProtocolError(THREAD_NOT_FOUND, error.message);
    }
    if (error.code === "TURN_NOT_ACTIVE") {
      return new ProtocolError(TURN_NOT_ACTIVE, error.message);
    }
    return new ProtocolError(INVALID_PARAMS, error.message);
  }
  return new ProtocolError(INTERNAL_ERROR, "Internal error");
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProtocolError(INVALID_PARAMS, "params must be an object");
  }
  return value;
}

function optionalRecord(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : requiredRecord(value);
}

function requiredNonEmptyString(value: unknown, field: string, trim = true): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProtocolError(INVALID_PARAMS, `${field} must be a non-empty string`);
  }
  return trim ? value.trim() : value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requiredNonEmptyString(value, field);
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ProtocolError(INVALID_PARAMS, `${field} must be a positive integer`);
  }
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}
