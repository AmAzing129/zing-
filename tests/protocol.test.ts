import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import test from "node:test";

import { ProtocolSession, runStdioAppServer } from "../src/protocol/index";
import type {
  AgentRuntime,
  RuntimeEvent,
  ThreadPage,
  ThreadSnapshot,
  TurnHandle,
  TurnInput,
} from "../src/runtime";

type Message = Record<string, unknown>;

class FakeRuntime implements AgentRuntime {
  readonly resetCalls: string[] = [];
  readonly cancelCalls: Array<[string, string]> = [];
  private readonly threads = new Set<string>();
  private nextTurn = 1;

  async openThread(threadId = "thr_generated") {
    const created = !this.threads.has(threadId);
    this.threads.add(threadId);
    return { threadId, created };
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    return { threadId, status: "idle", entries: [] };
  }

  async listThreads(): Promise<ThreadPage> {
    return {
      data: [...this.threads].map((threadId) => ({ threadId, updatedAt: 1 })),
      nextCursor: null,
    };
  }

  startTurn(input: TurnInput): TurnHandle {
    const turnId = `turn_${this.nextTurn++}`;
    let resolve!: (result: { text: string }) => void;
    const completed = new Promise<{ text: string }>((done) => {
      resolve = done;
    });
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const emit = (event: RuntimeEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };
    queueMicrotask(() => {
      const result = { text: "hello" };
      emit({ type: "turn/started", threadId: input.threadId, turnId });
      emit({
        type: "message/delta",
        threadId: input.threadId,
        turnId,
        messageId: "msg_1",
        delta: "hello",
      });
      emit({
        type: "message/completed",
        threadId: input.threadId,
        turnId,
        messageId: "msg_1",
        text: "hello",
      });
      emit({ type: "turn/completed", threadId: input.threadId, turnId, status: "completed", result });
      resolve(result);
    });
    return {
      turnId,
      completed,
      cancel: () => {},
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  async cancelTurn(threadId: string, turnId: string): Promise<void> {
    this.cancelCalls.push([threadId, turnId]);
  }

  async resetThread(threadId: string): Promise<void> {
    this.resetCalls.push(threadId);
  }
}

class PendingRuntime extends FakeRuntime {
  readonly handleCancelCalls: string[] = [];
  private nextPendingTurn = 1;

  override startTurn(): TurnHandle {
    const turnId = `pending_${this.nextPendingTurn++}`;
    let reject!: (error: Error) => void;
    const completed = new Promise<{ text: string }>((_resolve, onReject) => { reject = onReject; });
    return {
      turnId,
      completed,
      cancel: () => {
        this.handleCancelCalls.push(turnId);
        reject(new Error("canceled"));
      },
      subscribe: () => () => {},
    };
  }
}

const info = { agentId: "agt_test", name: "test", modelId: "model-test" };

function request(id: number, method: string, params?: unknown): Message {
  return { jsonrpc: "2.0", id, method, params };
}

function initialize(id = 1): Message {
  return request(id, "initialize", {
    protocolVersion: 1,
    clientInfo: { name: "test-client", version: "0.1.0" },
  });
}

test("protocol requires one supported initialize call", async () => {
  const messages: Message[] = [];
  const session = new ProtocolSession({
    runtime: new FakeRuntime(),
    info,
    write: (message) => {
      messages.push(message);
    },
  });

  await session.handleMessage(request(1, "thread/list", {}));
  await session.handleMessage(initialize(2));
  await session.handleMessage(initialize(3));
  await session.handleMessage(request(4, "unknown/method", {}));

  assert.equal((messages[0]?.error as Message).code, -32001);
  assert.deepEqual(messages[1], {
    jsonrpc: "2.0",
    id: 2,
    result: {
      protocolVersion: 1,
      agent: info,
      capabilities: { streaming: true, cancel: true, threadRead: true, threadList: true, approvals: true },
    },
  });
  assert.equal((messages[2]?.error as Message).code, -32002);
  assert.equal((messages[3]?.error as Message).code, -32601);
});

test("protocol exposes thread methods and streams turn events after its response", async () => {
  const runtime = new FakeRuntime();
  const messages: Message[] = [];
  const session = new ProtocolSession({
    runtime,
    info,
    write: (message) => {
      messages.push(message);
    },
  });
  await session.handleMessage(initialize());
  await session.handleMessage(request(2, "thread/open", { threadId: "telegram:1" }));
  await session.handleMessage(
    request(3, "turn/start", { threadId: "telegram:1", input: { type: "text", text: "hi" } }),
  );
  await session.close();
  await session.handleMessage(request(4, "thread/read", { threadId: "telegram:1" }));
  await session.handleMessage(request(5, "thread/list", {}));
  await session.handleMessage(request(6, "thread/reset", { threadId: "telegram:1" }));
  await session.handleMessage(request(7, "turn/cancel", { threadId: "telegram:1", turnId: "turn_1" }));

  const turnResponse = messages.findIndex((message) => message.id === 3);
  const turnStarted = messages.findIndex((message) => message.method === "turn/started");
  const turnCompleted = messages.find((message) => message.method === "turn/completed");
  assert.ok(turnResponse >= 0);
  assert.ok(turnStarted > turnResponse);
  assert.equal((turnCompleted?.params as Message).status, "completed");
  assert.deepEqual(runtime.resetCalls, ["telegram:1"]);
  assert.deepEqual(runtime.cancelCalls, [["telegram:1", "turn_1"]]);
});

/** Each turn asks its approver once and answers with the decision. */
class ApprovingRuntime extends FakeRuntime {
  readonly approvers: Array<TurnInput["approve"]> = [];
  readonly results: Array<Promise<{ text: string }>> = [];

  override startTurn(input: TurnInput): TurnHandle {
    this.approvers.push(input.approve);
    const controller = new AbortController();
    const request = { tool: "notion__create", description: "Create a page", input: { title: "x" } };
    const completed = (async () => ({ text: `approved: ${String(await input.approve?.(request, controller.signal))}` }))();
    this.results.push(completed);
    return { turnId: "turn_a", completed, cancel: () => controller.abort(), subscribe: () => () => {} };
  }
}

test("a client that declares approvals answers approval/requested; other clients get no approver", async () => {
  const silent = new ApprovingRuntime();
  const ignored = new ProtocolSession({ runtime: silent, info, write: () => {} });
  await ignored.handleMessage(initialize());
  await ignored.handleMessage(request(2, "turn/start", { threadId: "web:1", input: { type: "text", text: "go" } }));
  assert.equal(silent.approvers[0], undefined);

  const runtime = new ApprovingRuntime();
  const messages: Message[] = [];
  const session = new ProtocolSession({ runtime, info, write: (message) => void messages.push(message) });
  await session.handleMessage(
    request(1, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "web", version: "1" },
      capabilities: { approvals: true },
    }),
  );
  await session.handleMessage(request(2, "turn/start", { threadId: "web:1", input: { type: "text", text: "go" } }));
  const asked = messages.find((message) => message.method === "approval/requested");
  assert.ok(messages.indexOf(asked as Message) > messages.findIndex((message) => message.id === 2), "after turn/start's response");
  const params = asked?.params as Message;
  assert.deepEqual({ ...params, approvalId: "…" }, {
    type: "approval/requested",
    threadId: "web:1",
    turnId: "turn_a",
    approvalId: "…",
    tool: "notion__create",
    description: "Create a page",
    input: { title: "x" },
  });

  await session.handleMessage(request(3, "approval/respond", { approvalId: params.approvalId, approved: true }));
  assert.deepEqual(messages.find((message) => message.id === 3)?.result, {});
  assert.deepEqual(await runtime.results[0], { text: "approved: true" });
  await session.handleMessage(request(4, "approval/respond", { approvalId: params.approvalId, approved: false }));
  assert.equal((messages.find((message) => message.id === 4)?.error as Message).code, -32012);
  await session.close();
});

test("plugin methods are listed at initialize and routed by name; their errors carry the plugin's message", async () => {
  const messages: Message[] = [];
  let signal: AbortSignal | undefined;
  const session = new ProtocolSession({
    runtime: new FakeRuntime(),
    info,
    write: (message) => void messages.push(message),
    methods: [
      {
        name: "demo/echo",
        handle: async (params, context) => {
          signal = context.signal;
          return { echoed: params as string };
        },
      },
      {
        name: "demo/fail",
        handle: async () => {
          throw new Error("server demo is not connected");
        },
      },
    ],
  });
  await session.handleMessage(request(1, "demo/echo", "early"));
  await session.handleMessage(initialize(2));
  await session.handleMessage(request(3, "demo/echo", "hi"));
  await session.handleMessage(request(4, "demo/fail", {}));
  await session.handleMessage(request(5, "demo/missing", {}));

  assert.equal((messages[0]?.error as Message).code, -32001);
  assert.deepEqual((messages[1]?.result as Message).capabilities, {
    streaming: true,
    cancel: true,
    threadRead: true,
    threadList: true,
    approvals: true,
    methods: ["demo/echo", "demo/fail"],
  });
  assert.deepEqual(messages[2], { jsonrpc: "2.0", id: 3, result: { echoed: "hi" } });
  assert.deepEqual(messages[3]?.error, { code: -32020, message: "server demo is not connected" });
  assert.equal((messages[4]?.error as Message).code, -32601);
  assert.equal(signal?.aborted, false);
  await session.close();
  assert.equal(signal?.aborted, true);
});

test("closing a protocol session cancels every turn handle before waiting", async () => {
  const runtime = new PendingRuntime();
  const session = new ProtocolSession({ runtime, info, write: () => {} });
  await session.handleMessage(initialize());
  await session.handleMessage(request(2, "turn/start", { threadId: "web:1", input: { type: "text", text: "one" } }));
  await session.handleMessage(request(3, "turn/start", { threadId: "web:1", input: { type: "text", text: "two" } }));

  await session.close();

  assert.deepEqual(runtime.handleCancelCalls, ["pending_1", "pending_2"]);
});

test("protocol returns JSON-RPC parse and parameter errors", async () => {
  const messages: Message[] = [];
  const session = new ProtocolSession({
    runtime: new FakeRuntime(),
    info,
    write: (message) => {
      messages.push(message);
    },
  });
  await session.handleLine("not json");
  await session.handleMessage(initialize());
  await session.handleMessage(request(2, "turn/start", { threadId: "x", input: { type: "image" } }));

  assert.equal((messages[0]?.error as Message).code, -32700);
  assert.equal((messages[2]?.error as Message).code, -32602);
});

test("stdio transport reads and writes JSONL only", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
  });

  const running = runStdioAppServer(new FakeRuntime(), info, { input, output });
  input.end(
    `${JSON.stringify(initialize())}\n${JSON.stringify(request(2, "thread/open", { threadId: "web:1" }))}\n`,
  );
  await running;

  const messages = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Message);
  assert.deepEqual(
    messages.map((message) => message.id),
    [1, 2],
  );
  assert.ok(messages.every((message) => message.jsonrpc === "2.0"));
});

test("stdio transport stops when its host signal is aborted", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const controller = new AbortController();
  const running = runStdioAppServer(new FakeRuntime(), info, {
    input,
    output,
    signal: controller.signal,
  });

  controller.abort();
  await running;
  assert.equal(input.readableEnded, false);
});

test("the checked-in v1 schema is valid JSON and names every method and event", async () => {
  const schema = JSON.parse(await readFile("schemas/zing-protocol-v1.json", "utf8")) as unknown;
  assert.ok(isRecord(schema));
  const text = JSON.stringify(schema);
  for (const name of [
    "initialize",
    "thread/open",
    "thread/read",
    "thread/list",
    "thread/reset",
    "turn/start",
    "turn/cancel",
    "turn/started",
    "message/delta",
    "message/completed",
    "tool/started",
    "tool/completed",
    "turn/completed",
    "approval/requested",
    "approval/respond",
  ]) {
    assert.match(text, new RegExp(name.replace("/", "\\/")));
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
