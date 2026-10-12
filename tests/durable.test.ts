import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  contentText,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  Type,
  type Context,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { createAgent } from "../src/agent";
import type { Blueprint } from "../src/blueprint";
import { createMemoryCapsule, openFileCapsule, type Capsule } from "../src/capsule";
import { CONTEXT_OMISSION_TEXT } from "../src/context";
import { createDurableAgent, type CreateDurableAgentOptions } from "../src/durable";
import type { ConversationEvent, Tool, ToolContext } from "../src/plugin/index";
import type { Station } from "../src/station";

const WEB_SEARCH = "web_search";
const webSearch: Tool = {
  name: WEB_SEARCH,
  description: "Search the web",
  parameters: Type.Object({ query: Type.String() }),
  execute: async () => ({ text: "results" }),
};

function blueprintFor(modelId: string, tools: readonly Tool[] = [webSearch]): Blueprint {
  return { name: "test", model: modelId, system: "be brief", tools: tools.map((tool) => tool.name) };
}

function createTestStation(faux = fauxProvider(), getApiKey: Station["getApiKey"] = () => undefined) {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const station: Station = {
    resolveModel: (id) => (id === model.id ? model : { ...model, id, name: id }),
    models,
    streamFn: models.streamSimple.bind(models),
    getApiKey,
  };
  return { faux, model, station };
}

type Options = Partial<CreateDurableAgentOptions> & { blueprint?: Blueprint; capsule?: Capsule };

async function createTestAgent(options: Options = {}) {
  const { faux, model, station } = createTestStation();
  const tools = options.tools ?? [webSearch];
  const agent = await createDurableAgent(
    station,
    options.blueprint ?? blueprintFor(model.id, tools),
    options.capsule,
    { storage: options.storage ?? new MemoryStorage(), ...options, tools },
  );
  return { agent, faux, model, station };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal.aborted) fail();
    signal.addEventListener("abort", fail, { once: true });
  });
}

test("durable: a turn runs a tool call and answers", async () => {
  const contexts: ToolContext[] = [];
  const tool: Tool = { ...webSearch, execute: async (_input, context) => (contexts.push(context), { text: "found" }) };
  const capsule = createMemoryCapsule({ blueprintName: "test" });
  const { agent, faux } = await createTestAgent({ tools: [tool], capsule });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "zing" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("here is the answer"),
  ]);

  const result = await agent.handleMessage({ conversationId: "telegram:1", text: "what is zing", senderId: "alice" });
  assert.equal(result.text, "here is the answer");
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0]?.conversationId, "telegram:1");
  assert.equal(contexts[0]?.senderId, "alice");
  assert.equal(contexts[0]?.capsule.agentId, capsule.identity.agentId);
  assert.equal(contexts[0]?.capsule.state, capsule.state);
  assert.deepEqual(
    (await agent.readThread("telegram:1")).entries.map((entry) => entry.type),
    ["user", "assistant", "toolResult", "assistant"],
  );
  await agent.close();
});

test("durable: the thread keeps history and queues concurrent turns in order", async () => {
  const { agent, faux } = await createTestAgent();
  const seen: string[][] = [];
  const reply = (text: string) => (context: Context) => {
    seen.push(context.messages.filter((message) => message.role === "user").map((message) => contentText(message.content, "")));
    return fauxAssistantMessage(text);
  };
  faux.setResponses([reply("first"), reply("second")]);

  const first = agent.handleMessage({ conversationId: "telegram:1", text: "one" });
  const second = agent.handleMessage({ conversationId: "telegram:1", text: "two" });
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.text), ["first", "second"]);
  assert.deepEqual(seen, [["one"], ["one", "two"]]);
  await agent.close();
});

test("durable: startTurn streams message and tool events", async () => {
  const { agent, faux } = await createTestAgent();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "zing" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("streamed answer"),
  ]);
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const turn = agent.startTurn({ threadId: "web:1", text: "search" });
  turn.subscribe((event) => events.push(event));

  assert.equal((await turn.completed).text, "streamed answer");
  assert.equal(events[0]?.type, "turn/started");
  const deltas = events.filter((event) => event.type === "message/delta").map((event) => event.delta).join("");
  assert.equal(deltas, "streamed answer");
  assert.ok(events.some((event) => event.type === "message/completed" && event.text === "streamed answer"));
  const toolStart = events.find((event) => event.type === "tool/started");
  const toolEnd = events.find((event) => event.type === "tool/completed");
  assert.equal(toolStart?.callId, toolEnd?.callId);
  assert.deepEqual(toolStart?.input, { query: "zing" });
  assert.equal(toolEnd?.isError, false);
  assert.deepEqual(events.at(-1), {
    type: "turn/completed",
    threadId: "web:1",
    turnId: turn.turnId,
    status: "completed",
    result: { text: "streamed answer" },
  });
  await agent.close();
});

test("durable: a fast turn still reports its events before it completes", async () => {
  const { agent, faux } = await createTestAgent({ tools: [] });
  for (let index = 0; index < 40; index += 1) {
    faux.setResponses([fauxAssistantMessage(`answer ${index}`)]);
    const events: string[] = [];
    const turn = agent.startTurn({ threadId: "web:fast", text: `question ${index}` });
    turn.subscribe((event) => events.push(event.type));
    await turn.completed;
    assert.equal(events.at(-1), "turn/completed");
    assert.ok(events.includes("message/completed"), `turn ${index} reported ${events.join(", ")}`);
  }
  await agent.close();
});

test("durable: threads open, read, list, and reset", async () => {
  const { agent, faux } = await createTestAgent();
  assert.deepEqual(await agent.openThread("web:history"), { threadId: "web:history", created: true });
  assert.deepEqual(await agent.openThread("web:history"), { threadId: "web:history", created: false });
  faux.setResponses([fauxAssistantMessage("remembered"), fauxAssistantMessage("other"), fauxAssistantMessage("fresh")]);
  await agent.startTurn({ threadId: "web:history", text: "hello" }).completed;
  await new Promise((resolve) => setTimeout(resolve, 2));
  await agent.startTurn({ threadId: "web:other", text: "hello" }).completed;

  assert.deepEqual((await agent.readThread("web:history")).entries.map((entry) => entry.type), ["user", "assistant"]);
  assert.deepEqual((await agent.listThreads()).data.map((thread) => thread.threadId), ["web:other", "web:history"]);
  const page = await agent.listThreads({ limit: 1 });
  assert.equal(page.data.length, 1);
  assert.equal((await agent.listThreads({ cursor: page.nextCursor ?? undefined })).data[0]?.threadId, "web:history");

  await agent.resetThread("web:history");
  assert.deepEqual((await agent.readThread("web:history")).entries, []);
  assert.equal((await agent.startTurn({ threadId: "web:history", text: "again" }).completed).text, "fresh");
  assert.deepEqual((await agent.readThread("web:history")).entries.map((entry) => entry.type), ["user", "assistant"]);
  await assert.rejects(() => agent.readThread("missing"), /Thread not found/);
  await agent.close();
});

test("durable: reset waits behind the active turn", async () => {
  const started = deferred();
  const release = deferred();
  const search: Tool = {
    ...webSearch,
    async execute() {
      started.resolve();
      await release.promise;
      return { text: "done" };
    },
  };
  const { agent, faux } = await createTestAgent({ tools: [search] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "wait" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);
  const turn = agent.startTurn({ threadId: "web:reset-order", text: "run" });
  await started.promise;
  const reset = agent.resetThread("web:reset-order");
  release.resolve();
  assert.equal((await turn.completed).text, "finished");
  await reset;
  assert.deepEqual((await agent.readThread("web:reset-order")).entries, []);
  await agent.close();
});

test("durable: cancel aborts the active turn, its tool, and keeps the thread usable", async () => {
  const started = deferred();
  let received: AbortSignal | undefined;
  const search: Tool = {
    ...webSearch,
    execute: async (_input, { signal }) => {
      received = signal;
      started.resolve();
      return waitForAbort(signal);
    },
  };
  const { agent, faux } = await createTestAgent({ tools: [search] });
  faux.setResponses([fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "wait" })], { stopReason: "toolUse" })]);
  const events: Array<{ type: string; status?: string }> = [];
  const turn = agent.startTurn({ threadId: "web:cancel", text: "run" });
  turn.subscribe((event) => events.push(event));
  await started.promise;
  await agent.cancelTurn("web:cancel", turn.turnId);

  await assert.rejects(turn.completed, /canceled/i);
  assert.equal(received?.aborted, true);
  assert.deepEqual(events.at(-1), { type: "turn/completed", threadId: "web:cancel", turnId: turn.turnId, status: "canceled" });
  await assert.rejects(() => agent.cancelTurn("web:cancel", turn.turnId), /not active/);

  faux.setResponses([fauxAssistantMessage("recovered")]);
  assert.equal((await agent.startTurn({ threadId: "web:cancel", text: "again" }).completed).text, "recovered");
  await agent.close();
});

test("durable: a queued turn can be canceled before the model runs", async () => {
  const started = deferred();
  const search: Tool = {
    ...webSearch,
    execute: async (_input, { signal }) => {
      started.resolve();
      return waitForAbort(signal);
    },
  };
  const { agent, faux } = await createTestAgent({ tools: [search] });
  faux.setResponses([fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "wait" })], { stopReason: "toolUse" })]);

  const current = agent.startTurn({ threadId: "web:queued", text: "one" });
  await started.promise;
  const queued = agent.startTurn({ threadId: "web:queued", text: "two" });
  const events: string[] = [];
  queued.subscribe((event) => events.push(event.type));
  queued.cancel();
  await agent.cancelTurn("web:queued", current.turnId);

  await assert.rejects(current.completed, /canceled/i);
  await assert.rejects(queued.completed, /canceled/i);
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(events, ["turn/completed"]);
  await agent.close();
});

test("durable: a model error fails its turn without blocking the next", async () => {
  const { agent, faux } = await createTestAgent();
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "model failed" }),
    fauxAssistantMessage("recovered"),
  ]);
  const failed = agent.handleMessage({ conversationId: "telegram:1", text: "one" });
  const next = agent.handleMessage({ conversationId: "telegram:1", text: "two" });
  await assert.rejects(failed, /model failed/);
  assert.equal((await next).text, "recovered");
  await agent.close();
});

test("durable: long threads prune only the model context and keep the system prompt", async () => {
  const faux = fauxProvider({ models: [{ id: "tiny-context", contextWindow: 512, maxTokens: 64 }] });
  const { model, station } = createTestStation(faux);
  const agent = await createDurableAgent(
    station,
    { name: "long-lived", model: model.id, system: "Be brief.", tools: [] },
    undefined,
    { storage: new MemoryStorage() },
  );
  const seen: string[][] = [];
  const systems: string[] = [];
  faux.setResponses(
    Array.from({ length: 10 }, (_, index) => (context: Context) => {
      systems.push(getCurrentSystemPrompt(context.messages) ?? "");
      seen.push(context.messages.filter((message) => message.role !== "system").map((message) => contentText(message.content, "")));
      return fauxAssistantMessage(`answer-${index}`);
    }),
  );

  for (let index = 0; index < 10; index += 1) {
    await agent.handleMessage({ conversationId: "chat:long", text: `turn-${index} ${"x".repeat(220)}` });
  }

  const last = seen.at(-1) ?? [];
  assert.deepEqual(new Set(systems), new Set(["Be brief."]));
  assert.equal(last[0], CONTEXT_OMISSION_TEXT);
  assert.ok(!last.some((text) => text.startsWith("turn-0 ")));
  assert.ok(last.some((text) => text.startsWith("turn-9 ")));
  const history = await agent.readThread("chat:long");
  assert.equal(history.entries.length, 20);
  assert.match(history.entries[0]?.type === "user" ? contentText(history.entries[0].content, "") : "", /^turn-0 /);
  await agent.close();
});

test("durable: an oversized user input fails before calling the model", async () => {
  const faux = fauxProvider({ models: [{ id: "tiny-input", contextWindow: 256, maxTokens: 64 }] });
  const { model, station } = createTestStation(faux);
  const observed: ConversationEvent[] = [];
  const agent = await createDurableAgent(
    station,
    { name: "bounded", model: model.id, system: "Be brief.", tools: [] },
    undefined,
    { storage: new MemoryStorage(), listeners: [(event) => { observed.push(event); }] },
  );
  await assert.rejects(
    agent.handleMessage({ conversationId: "chat:oversized", text: "x".repeat(2_000) }),
    /User input exceeded.*context budget/,
  );
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual((await agent.readThread("chat:oversized")).entries, []);
  await agent.drainObservers();
  assert.deepEqual(observed, []);
  await agent.close();
});

test("durable: an oversized tool result stops before another model call", async () => {
  const faux = fauxProvider({ models: [{ id: "tiny-tool-result", contextWindow: 256, maxTokens: 64 }] });
  const { model, station } = createTestStation(faux);
  const tool: Tool = {
    name: "data__expand",
    description: "Return a large result",
    parameters: Type.Object({}),
    execute: async () => ({ text: "x".repeat(2_000) }),
  };
  const agent = await createDurableAgent(
    station,
    { name: "bounded", model: model.id, system: "Use the tool.", tools: [tool.name] },
    undefined,
    { storage: new MemoryStorage(), tools: [tool] },
  );
  faux.setResponses([fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" })]);

  await assert.rejects(
    agent.handleMessage({ conversationId: "chat:large", text: "expand" }),
    /Current turn exceeded.*context budget/,
  );
  assert.equal(faux.state.callCount, 1);
  const history = await agent.readThread("chat:large");
  assert.deepEqual(history.entries.slice(0, 3).map((entry) => entry.type), ["user", "assistant", "toolResult"]);
  await agent.close();
});

test("durable: the model-turn budget stops a repeating tool loop", async () => {
  const { agent, faux } = await createTestAgent({ limits: { maxModelTurns: 2 } });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "one" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "two" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "three" })], { stopReason: "toolUse" }),
  ]);
  await assert.rejects(agent.handleMessage({ conversationId: "chat:model-budget", text: "loop" }), /2 model-turn limit/);
  assert.equal(faux.state.callCount, 2);
  await agent.close();
});

test("durable: the tool-call budget blocks excess calls before execution", async () => {
  let executions = 0;
  const tool: Tool = {
    name: "counter__increment",
    description: "Increment a counter",
    parameters: Type.Object({}),
    execute: async () => ({ text: String(++executions) }),
  };
  const { agent, faux } = await createTestAgent({
    tools: [tool],
    limits: { maxToolCalls: 1 },
    blueprint: { name: "budget", model: "faux-1", system: "Count.", tools: [tool.name] },
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, {}), fauxToolCall(tool.name, {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("should not be needed"),
  ]);
  await assert.rejects(agent.handleMessage({ conversationId: "chat:tool-budget", text: "twice" }), /1 tool-call limit/);
  assert.equal(executions, 1);
  await agent.close();
});

test("durable: the turn timeout settles even when a plugin ignores abort", async () => {
  let received: AbortSignal | undefined;
  const tool: Tool = {
    name: "wait__forever",
    description: "Never finish",
    parameters: Type.Object({}),
    execute: async (_input, { signal }) => {
      received = signal;
      return new Promise<never>(() => {});
    },
  };
  const { agent, faux } = await createTestAgent({
    tools: [tool],
    limits: { turnTimeoutMs: 50 },
    blueprint: { name: "timeout", model: "faux-1", system: "Wait.", tools: [tool.name] },
  });
  faux.setResponses([fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" })]);
  const events: Array<{ type: string; status?: string }> = [];
  const turn = agent.startTurn({ threadId: "chat:timeout", text: "wait" });
  turn.subscribe((event) => events.push(event));
  await assert.rejects(turn.completed, /50ms timeout/);
  assert.equal(received?.aborted, true);
  assert.equal(events.at(-1)?.status, "failed");
  await agent.close();
});

test("durable: observers receive completed, failed, and canceled turns and resets", async () => {
  const started = deferred();
  const tool: Tool = {
    ...webSearch,
    execute: async (_input, { signal }) => {
      started.resolve();
      return waitForAbort(signal);
    },
  };
  const events: ConversationEvent[] = [];
  const { agent, faux } = await createTestAgent({ tools: [tool], listeners: [(event) => { events.push(event); }] });
  faux.setResponses([
    fauxAssistantMessage("observed"),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "failed" }),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "wait" })], { stopReason: "toolUse" }),
  ]);

  await agent.handleMessage({ conversationId: "chat:observed", text: "hello", senderId: "alice" });
  await agent.drainObservers();
  const snapshot = await agent.readThread("chat:observed");
  assert.deepEqual(events.map(({ capsule, ...event }) => ({ ...event, agentId: capsule.agentId })), [{
    type: "turn",
    conversationId: "chat:observed",
    senderId: "alice",
    agentId: agent.agentId,
    status: "completed",
    entries: snapshot.entries,
  }]);

  await assert.rejects(agent.handleMessage({ conversationId: "chat:observed", text: "fail", senderId: "bob" }), /failed/);
  const canceled = agent.startTurn({ threadId: "chat:observed", text: "cancel", senderId: "carol" });
  await started.promise;
  await agent.cancelTurn("chat:observed", canceled.turnId);
  await assert.rejects(canceled.completed, /canceled/i);
  await agent.resetThread("chat:observed");
  await agent.drainObservers();

  assert.deepEqual(
    events.map((event) => [event.type, event.type === "turn" ? event.status : undefined, event.type === "turn" ? event.senderId : undefined]),
    [
      ["turn", "completed", "alice"],
      ["turn", "failed", "bob"],
      ["turn", "canceled", "carol"],
      ["reset", undefined, undefined],
    ],
  );
  const failed = events[1];
  assert.deepEqual(failed?.type === "turn" ? failed.entries.map((entry) => entry.type) : [], ["user", "assistant"]);
  await agent.close();
});

test("durable: provider plugin API keys reach the model request", async () => {
  const faux = fauxProvider();
  const { model, station } = createTestStation(faux, (provider) => (provider === faux.getModel().provider ? "secret" : undefined));
  const agent = await createDurableAgent(station, blueprintFor(model.id, []), undefined, { storage: new MemoryStorage() });
  const keys: Array<string | undefined> = [];
  faux.setResponses([(_context, options) => (keys.push(options?.apiKey), fauxAssistantMessage("ok"))]);
  await agent.handleMessage({ conversationId: "chat:key", text: "hi" });
  assert.deepEqual(keys, ["secret"]);
  await agent.close();
});

test("durable: a restarted station resumes the interrupted turn and answers its redelivery once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const started = deferred();
  let executions = 0;
  const senders: Array<string | undefined> = [];
  const hanging: Tool = {
    ...webSearch,
    execute: async (_input, { signal, senderId }) => {
      executions += 1;
      senders.push(senderId);
      started.resolve();
      return waitForAbort(signal);
    },
  };

  const first = createTestStation();
  const before = await createDurableAgent(first.station, blueprintFor(first.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [hanging],
  });
  first.faux.setResponses([fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "slow" })], { stopReason: "toolUse" })]);
  const interrupted = before.handleMessage({
    conversationId: "telegram:1",
    text: "look it up",
    senderId: "alice",
    requestId: "update:7",
  });
  await started.promise;
  await before.close();
  await assert.rejects(interrupted, /resumes when the station restarts/);

  const second = createTestStation();
  const finishing: Tool = {
    ...webSearch,
    execute: async (_input, { senderId }) => (senders.push(senderId), { text: "fresh results" }),
  };
  const toolResults: string[] = [];
  second.faux.setResponses([
    (context: Context) => {
      for (const message of context.messages) {
        if (message.role === "toolResult") toolResults.push(contentText(message.content, ""));
      }
      return fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "again" })], { stopReason: "toolUse" });
    },
    fauxAssistantMessage("recovered answer"),
  ]);
  const observed: ConversationEvent[] = [];
  const after = await createDurableAgent(second.station, blueprintFor(second.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [finishing],
    listeners: [(event) => { observed.push(event); }],
  });
  assert.equal(after.agentId, before.agentId);

  // The channel redelivers the unacknowledged message; it joins the recovered turn instead of running twice.
  const redelivered = await after.handleMessage({
    conversationId: "telegram:1",
    text: "look it up",
    senderId: "alice",
    requestId: "update:7",
  });
  assert.equal(redelivered.text, "recovered answer");
  assert.equal(executions, 1, "an interrupted tool call is not replayed");
  assert.match(toolResults[0] ?? "", /interrupted/);
  assert.deepEqual(senders, ["alice", "alice"], "a recovered run keeps its sender's trust");
  assert.equal(second.faux.state.callCount, 2);
  const transcript = (await after.readThread("telegram:1")).entries;
  assert.deepEqual(
    transcript.map((entry) => entry.type),
    ["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"],
  );
  await after.drainObservers();
  assert.deepEqual(
    observed.map((event) => event.type === "turn" && [event.status, event.senderId, event.entries]),
    [["completed", "alice", transcript]],
    "the recovered turn is observed once, not again for its redelivery",
  );
  await after.close();
});

test("durable: a recovered turn is observed and touches its thread without any redelivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-observe-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const started = deferred();
  const hanging: Tool = { ...webSearch, execute: async (_input, { signal }) => (started.resolve(), waitForAbort(signal)) };
  const first = createTestStation();
  const before = await createDurableAgent(first.station, blueprintFor(first.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [hanging],
  });
  first.faux.setResponses([fauxAssistantMessage("quiet")]);
  await before.handleMessage({ conversationId: "chat:quiet", text: "hi" });
  first.faux.setResponses([fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "x" })], { stopReason: "toolUse" })]);
  const interrupted = before.handleMessage({ conversationId: "chat:busy", text: "remember this", senderId: "bob" });
  await started.promise;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await before.close();
  await assert.rejects(interrupted);

  const second = createTestStation();
  const turnObserved = deferred();
  const modelCalled = deferred();
  const answer = deferred();
  const observed: ConversationEvent[] = [];
  second.faux.setResponses([
    async () => {
      modelCalled.resolve();
      await answer.promise;
      return fauxAssistantMessage("finished after restart");
    },
  ]);
  const after = await createDurableAgent(second.station, blueprintFor(second.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [webSearch],
    listeners: [(event) => { observed.push(event); turnObserved.resolve(); }],
  });
  await modelCalled.promise;
  assert.equal((await after.readThread("chat:busy")).status, "active", "recovering work is reported as active");
  answer.resolve();
  await turnObserved.promise;
  assert.equal((await after.readThread("chat:busy")).status, "idle");
  const event = observed[0];
  assert.equal(event?.type, "turn");
  assert.equal(event?.type === "turn" ? event.status : undefined, "completed");
  assert.equal(event?.type === "turn" ? event.senderId : undefined, "bob");
  assert.deepEqual(
    event?.type === "turn" ? event.entries.map((entry) => entry.type) : [],
    ["user", "assistant", "toolResult", "assistant"],
  );
  await after.drainObservers();
  assert.equal((await after.listThreads()).data[0]?.threadId, "chat:busy", "the recovered thread is the most recent");
  await after.close();
});

test("durable: a settled turn whose observers never finished is observed after a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-unobserved-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const observerStarted = deferred();
  const releaseObserver = deferred();
  const first = createTestStation();
  // The first process answers, then dies while its observer is still running: it is never closed.
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file),
    observerTimeoutMs: 60_000,
    listeners: [async () => { observerStarted.resolve(); await releaseObserver.promise; }],
  });
  first.faux.setResponses([fauxAssistantMessage("remember: tea, not coffee")]);
  assert.equal(
    (await crashed.handleMessage({ conversationId: "telegram:1", text: "I prefer tea", senderId: "alice", requestId: "update:1" })).text,
    "remember: tea, not coffee",
  );
  await observerStarted.promise;

  const second = createTestStation();
  const observed: ConversationEvent[] = [];
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file),
    listeners: [(event) => { observed.push(event); }],
  });
  // The channel redelivers the update too; it is answered from the original turn and not observed twice.
  assert.equal(
    (await restarted.handleMessage({ conversationId: "telegram:1", text: "I prefer tea", senderId: "alice", requestId: "update:1" })).text,
    "remember: tea, not coffee",
  );
  await restarted.drainObservers();
  assert.equal(second.faux.state.callCount, 0);
  assert.deepEqual(
    observed.map((event) => event.type === "turn" && [event.status, event.senderId, event.entries.map((entry) => entry.type)]),
    [["completed", "alice", ["user", "assistant"]]],
  );
  await restarted.close();

  // Once recorded, a later start does not observe it again.
  const third = createTestStation();
  const later: ConversationEvent[] = [];
  const again = await createDurableAgent(third.station, blueprintFor(third.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file),
    listeners: [(event) => { later.push(event); }],
  });
  third.faux.setResponses([fauxAssistantMessage("next answer")]);
  // Queued behind any recovery of this thread, so a second observation would arrive first.
  await again.handleMessage({ conversationId: "telegram:1", text: "next" });
  await again.drainObservers();
  assert.deepEqual(
    later.map((event) => event.type === "turn" && event.entries.map((entry) => entry.type === "user" && entry.content)),
    [["next", false]],
  );
  await again.close();
  releaseObserver.resolve();
  await crashed.close().catch(() => undefined);
});

test("durable: every unobserved turn of a thread survives a crash, not only the latest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-unobserved-many-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const observerStarted = deferred();
  const release = deferred();
  const first = createTestStation();
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file),
    observerTimeoutMs: 60_000,
    listeners: [async () => { observerStarted.resolve(); await release.promise; }],
  });
  first.faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await crashed.handleMessage({ conversationId: "telegram:1", text: "first", senderId: "alice" });
  await observerStarted.promise;
  // The second turn starts while the first one's observer is still running; both die unobserved.
  await crashed.handleMessage({ conversationId: "telegram:1", text: "second", senderId: "bob" });

  const second = createTestStation();
  const observed: ConversationEvent[] = [];
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file),
    listeners: [(event) => { observed.push(event); }],
  });
  second.faux.setResponses([fauxAssistantMessage("c")]);
  await restarted.handleMessage({ conversationId: "telegram:1", text: "third", senderId: "carol" });
  await restarted.drainObservers();
  assert.deepEqual(
    observed.map((event) => event.type === "turn" && [event.senderId, event.entries[0]?.type === "user" && event.entries[0].content]),
    [["alice", "first"], ["bob", "second"], ["carol", "third"]],
  );
  await restarted.close();
  release.resolve();
  await crashed.close().catch(() => undefined);
});

test("durable: a turn that ran over budget stays failed across a crash and a redelivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-failure-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const observerStarted = deferred();
  const release = deferred();
  const first = createTestStation();
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [webSearch],
    limits: { maxToolCalls: 1 },
    observerTimeoutMs: 60_000,
    listeners: [async () => { observerStarted.resolve(); await release.promise; }],
  });
  first.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "a" }), fauxToolCall(WEB_SEARCH, { query: "b" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("never"),
  ]);
  const request = { conversationId: "telegram:1", text: "search twice", senderId: "alice", requestId: "update:9" };
  await assert.rejects(crashed.handleMessage(request), /1 tool-call limit/);
  await observerStarted.promise;

  const second = createTestStation();
  const observed: ConversationEvent[] = [];
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [webSearch],
    listeners: [(event) => { observed.push(event); }],
  });
  await assert.rejects(restarted.handleMessage(request), /1 tool-call limit/);
  await restarted.drainObservers();
  assert.equal(second.faux.state.callCount, 0);
  assert.deepEqual(
    observed.map((event) => event.type === "turn" && [event.status, event.senderId]),
    [["failed", "alice"]],
  );
  await restarted.close();
  release.resolve();
  await crashed.close().catch(() => undefined);
});

test("durable: a recovered unanswered turn is observed with its own entries only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-unanswered-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const observerStarted = deferred();
  const release = deferred();
  const first = createTestStation();
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file),
    observerTimeoutMs: 60_000,
    listeners: [async () => { observerStarted.resolve(); await release.promise; }],
  });
  first.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "owner turn failed" }),
    fauxAssistantMessage("group answer"),
  ]);
  await assert.rejects(crashed.handleMessage({ conversationId: "group:1", text: "owner", senderId: "owner" }), /owner turn failed/);
  await observerStarted.promise;
  await crashed.handleMessage({ conversationId: "group:1", text: "member", senderId: "member" });

  const second = createTestStation();
  const observed: ConversationEvent[] = [];
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file),
    listeners: [(event) => { observed.push(event); }],
  });
  second.faux.setResponses([fauxAssistantMessage("after")]);
  await restarted.handleMessage({ conversationId: "group:1", text: "after", senderId: "owner" });
  await restarted.drainObservers();
  assert.deepEqual(
    observed.map((event) =>
      event.type === "turn" && [event.status, event.senderId, event.entries.map((entry) => (entry.type === "user" ? entry.content : entry.type))],
    ),
    [
      ["failed", "owner", ["owner", "assistant"]],
      ["completed", "member", ["member", "assistant"]],
      ["completed", "owner", ["after", "assistant"]],
    ],
  );
  await restarted.close();
  release.resolve();
  await crashed.close().catch(() => undefined);
});

test("durable: a thread stays active until every queued recovery on it finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-recovering-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const observerStarted = deferred();
  const release = deferred();
  const toolStarted = deferred();
  const hanging: Tool = { ...webSearch, execute: async (_input, { signal }) => (toolStarted.resolve(), waitForAbort(signal)) };
  const first = createTestStation();
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [hanging],
    observerTimeoutMs: 60_000,
    listeners: [async () => { observerStarted.resolve(); await release.promise; }],
  });
  first.faux.setResponses([
    fauxAssistantMessage("a"),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "b" })], { stopReason: "toolUse" }),
  ]);
  await crashed.handleMessage({ conversationId: "chat:two", text: "a" });
  await observerStarted.promise;
  const abandoned = crashed.startTurn({ threadId: "chat:two", text: "b" });
  void abandoned.completed.catch(() => undefined);
  await toolStarted.promise;

  // The first recovery (an unobserved settled turn) finishes before the second (a resumed run) does.
  const second = createTestStation();
  const modelCalled = deferred();
  const answer = deferred();
  const observed: ConversationEvent[] = [];
  const allObserved = deferred();
  second.faux.setResponses([
    async () => {
      modelCalled.resolve();
      await answer.promise;
      return fauxAssistantMessage("b answered after restart");
    },
  ]);
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [webSearch],
    listeners: [(event) => { observed.push(event); if (observed.length === 2) allObserved.resolve(); }],
  });
  await modelCalled.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(observed.length, 1, "the settled turn was already reported");
  assert.equal((await restarted.readThread("chat:two")).status, "active");
  answer.resolve();
  await allObserved.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await restarted.readThread("chat:two")).status, "idle");
  await restarted.close();
  release.resolve();
  await crashed.close().catch(() => undefined);
});

test("durable: a resumed run keeps its limits while an earlier recovery on its thread finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-recovered-budget-"));
  const file = join(dir, "durable.sqlite");
  // "Crashed" processes here stay open on the same file; a short busy timeout keeps their late writes from stalling.
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const observerStarted = deferred();
  const release = deferred();
  const toolStarted = deferred();
  const hanging: Tool = { ...webSearch, execute: async (_input, { signal }) => (toolStarted.resolve(), waitForAbort(signal)) };
  const first = createTestStation();
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    tools: [hanging],
    observerTimeoutMs: 60_000,
    listeners: [async () => { observerStarted.resolve(); await release.promise; }],
  });
  first.faux.setResponses([
    fauxAssistantMessage("a"),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "b" })], { stopReason: "toolUse" }),
  ]);
  await crashed.handleMessage({ conversationId: "chat:limits", text: "a" });
  await observerStarted.promise;
  void crashed.startTurn({ threadId: "chat:limits", text: "b", senderId: "bob" }).completed.catch(() => undefined);
  await toolStarted.promise;

  // After restart the resumed model call never answers; only the turn timeout can end it.
  const second = createTestStation();
  const observed: ConversationEvent[] = [];
  const bothObserved = deferred();
  second.faux.setResponses([
    async (_context, options) => {
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return fauxAssistantMessage("", { stopReason: "aborted" });
    },
  ]);
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    tools: [webSearch],
    limits: { turnTimeoutMs: 300 },
    observerTimeoutMs: 60_000,
    listeners: [async (event) => {
      observed.push(event);
      if (observed.length === 2) {
        bothObserved.resolve();
        await release.promise;
      }
    }],
  });
  await bothObserved.promise;
  assert.deepEqual(
    observed.map((event) => event.type === "turn" && [event.status, event.senderId]),
    [["completed", undefined], ["failed", "bob"]],
  );
  assert.equal((await restarted.readThread("chat:limits")).status, "idle");

  // That process dies too before its observer finishes; the timeout must have been recorded with the turn.
  const third = createTestStation();
  const later: ConversationEvent[] = [];
  const again = await createDurableAgent(third.station, blueprintFor(third.model.id), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    tools: [webSearch],
    listeners: [(event) => { later.push(event); }],
  });
  third.faux.setResponses([fauxAssistantMessage("c")]);
  await again.handleMessage({ conversationId: "chat:limits", text: "c" });
  await again.drainObservers();
  assert.deepEqual(
    later.map((event) => event.type === "turn" && [event.status, event.senderId]),
    [["failed", "bob"], ["completed", undefined]],
  );
  await again.close();
  release.resolve();
  await crashed.close().catch(() => undefined);
  await restarted.close().catch(() => undefined);
});

test("durable: every budget failure stays reportable to its redelivery", async () => {
  const { agent, faux } = await createTestAgent({ limits: { maxToolCalls: 1 } });
  const twice = () =>
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "a" }), fauxToolCall(WEB_SEARCH, { query: "b" })], {
      stopReason: "toolUse",
    });
  for (let index = 0; index < 20; index += 1) {
    faux.setResponses([twice()]);
    await assert.rejects(
      agent.handleMessage({ conversationId: "chat:failures", text: `try ${index}`, requestId: `update:${index}` }),
      /1 tool-call limit/,
    );
  }
  const calls = faux.state.callCount;
  await assert.rejects(
    agent.handleMessage({ conversationId: "chat:failures", text: "try 0", requestId: "update:0" }),
    /1 tool-call limit/,
  );
  assert.equal(faux.state.callCount, calls);
  await agent.close();
});

test("durable: a storage failure that poisons the session stops the agent and reports it once", async () => {
  let failing = false;
  const memory = new MemoryStorage();
  const storage = new Proxy(memory, {
    get(target, property) {
      if (property === "commit" && failing) {
        return async () => {
          throw new Error("disk is gone");
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const fatal: Error[] = [];
  const { agent, faux } = await createTestAgent({ storage, onFatal: (error) => fatal.push(error) });
  faux.setResponses([fauxAssistantMessage("fine"), fauxAssistantMessage("never")]);
  assert.equal((await agent.handleMessage({ conversationId: "chat:disk", text: "one" })).text, "fine");

  failing = true;
  await assert.rejects(agent.handleMessage({ conversationId: "chat:disk", text: "two" }));
  assert.equal(fatal.length, 1);
  assert.match(fatal[0]?.message ?? "", /Session is poisoned/);
  assert.throws(() => agent.startTurn({ threadId: "chat:disk", text: "three" }), /shutting down/);
  await agent.close();
  assert.equal(fatal.length, 1);
});

test("durable: a reset does not drop a turn whose observer had not finished", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-reset-unobserved-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const observerStarted = deferred();
  const release = deferred();
  const first = createTestStation();
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    observerTimeoutMs: 60_000,
    listeners: [async () => { observerStarted.resolve(); await release.promise; }],
  });
  first.faux.setResponses([fauxAssistantMessage("noted")]);
  await crashed.handleMessage({ conversationId: "telegram:1", text: "I like tea", senderId: "alice" });
  await observerStarted.promise;
  await crashed.resetThread("telegram:1");

  const second = createTestStation();
  const observed: ConversationEvent[] = [];
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id, []), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    listeners: [(event) => { observed.push(event); }],
  });
  second.faux.setResponses([fauxAssistantMessage("fresh")]);
  await restarted.handleMessage({ conversationId: "telegram:1", text: "new topic", senderId: "alice" });
  await restarted.drainObservers();
  assert.deepEqual(
    observed.map((event) => event.type === "turn" && event.entries.map((entry) => (entry.type === "user" ? entry.content : entry.type))),
    [["I like tea", "assistant"], ["new topic", "assistant"]],
  );
  assert.deepEqual((await restarted.readThread("telegram:1")).entries.map((entry) => entry.type), ["user", "assistant"]);
  await restarted.close();
  release.resolve();
  await crashed.close().catch(() => undefined);
});

test("durable: a resumed turn keeps the model rounds and tool calls it already spent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-spent-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const toolStarted = deferred();
  const hanging: Tool = { ...webSearch, execute: async (_input, { signal }) => (toolStarted.resolve(), waitForAbort(signal)) };
  const first = createTestStation();
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    tools: [hanging],
    limits: { maxToolCalls: 1 },
  });
  first.faux.setResponses([fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "one" })], { stopReason: "toolUse" })]);
  void crashed.startTurn({ threadId: "chat:spent", text: "loop", senderId: "alice" }).completed.catch(() => undefined);
  await toolStarted.promise;

  // The restarted station allows one tool call per turn; this turn already made it before the crash.
  let executions = 0;
  const counting: Tool = { ...webSearch, execute: async () => (executions++, { text: "more" }) };
  const second = createTestStation();
  const observed = deferred();
  const events: ConversationEvent[] = [];
  second.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "two" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("should not be reached"),
  ]);
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    tools: [counting],
    limits: { maxToolCalls: 1 },
    listeners: [(event) => { events.push(event); observed.resolve(); }],
  });
  await observed.promise;
  assert.equal(executions, 0, "the second call is blocked, not run");
  assert.equal(second.faux.state.callCount, 1);
  assert.deepEqual(events.map((event) => event.type === "turn" && [event.status, event.senderId]), [["failed", "alice"]]);
  const blocked = (await restarted.readThread("chat:spent")).entries.at(-1);
  assert.match(blocked?.type === "toolResult" ? contentText(blocked.content, "") : "", /1 tool-call limit/);
  await restarted.close();
  await crashed.close().catch(() => undefined);
});

test("durable: a resumed turn keeps the model rounds it already spent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-spent-rounds-"));
  const file = join(dir, "durable.sqlite");
  const capsule = await openFileCapsule({ blueprint: blueprintFor("faux-1"), path: dir });
  const toolStarted = deferred();
  const hanging: Tool = { ...webSearch, execute: async (_input, { signal }) => (toolStarted.resolve(), waitForAbort(signal)) };
  const first = createTestStation();
  const crashed = await createDurableAgent(first.station, blueprintFor(first.model.id), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    tools: [hanging],
    limits: { maxModelTurns: 2 },
  });
  first.faux.setResponses([fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "one" })], { stopReason: "toolUse" })]);
  void crashed.startTurn({ threadId: "chat:rounds", text: "loop" }).completed.catch(() => undefined);
  await toolStarted.promise;

  const second = createTestStation();
  const observed = deferred();
  const events: ConversationEvent[] = [];
  second.faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "two" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "three" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("should not be reached"),
  ]);
  const restarted = await createDurableAgent(second.station, blueprintFor(second.model.id), capsule, {
    storage: await openNodeSqliteStorage(file, { busyTimeoutMs: 200 }),
    tools: [webSearch],
    limits: { maxModelTurns: 2 },
    listeners: [(event) => { events.push(event); observed.resolve(); }],
  });
  await observed.promise;
  assert.equal(second.faux.state.callCount, 1, "the second round is the last one");
  assert.deepEqual(events.map((event) => event.type === "turn" && event.status), ["failed"]);
  await restarted.close();
  await crashed.close().catch(() => undefined);
});

test("durable: a repeated request ID returns the original answer without re-observing history", async () => {
  const events: ConversationEvent[] = [];
  const { agent, faux } = await createTestAgent({ listeners: [(event) => { events.push(event); }] });
  faux.setResponses([fauxAssistantMessage("original"), fauxAssistantMessage("later")]);

  assert.equal((await agent.handleMessage({ conversationId: "chat:dedupe", text: "one", requestId: "r1" })).text, "original");
  assert.equal((await agent.handleMessage({ conversationId: "chat:dedupe", text: "two", requestId: "r2" })).text, "later");
  const retried = agent.startTurn({ threadId: "chat:dedupe", text: "one", senderId: "mallory", requestId: "r1" });
  const statuses: string[] = [];
  retried.subscribe((event) => statuses.push(event.type));
  assert.equal((await retried.completed).text, "original");
  await agent.drainObservers();

  assert.equal(faux.state.callCount, 2);
  assert.deepEqual(statuses, ["turn/started", "turn/completed"]);
  assert.deepEqual(
    events.map((event) => event.type === "turn" && event.entries.map((entry) => entry.type)),
    [["user", "assistant"], ["user", "assistant"]],
  );
  assert.equal((await agent.readThread("chat:dedupe")).entries.length, 4);
  await agent.close();
});

test("durable: any opaque thread ID survives a restart, including __proto__", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-ids-"));
  const file = join(dir, "durable.sqlite");
  const { faux, model, station } = createTestStation();
  const blueprint = blueprintFor(model.id, []);
  const first = await createDurableAgent(station, blueprint, undefined, { storage: await openNodeSqliteStorage(file) });
  faux.setResponses([fauxAssistantMessage("a"), fauxAssistantMessage("b")]);
  await first.handleMessage({ conversationId: "__proto__", text: "hi" });
  await first.handleMessage({ conversationId: "constructor", text: "hi" });
  await first.close();

  const second = await createDurableAgent(station, blueprint, undefined, { storage: await openNodeSqliteStorage(file) });
  assert.deepEqual((await second.listThreads()).data.map((thread) => thread.threadId).sort(), ["__proto__", "constructor"]);
  assert.deepEqual((await second.readThread("__proto__")).entries.map((entry) => entry.type), ["user", "assistant"]);
  assert.deepEqual(await second.openThread("__proto__"), { threadId: "__proto__", created: false });
  await second.close();
});

test("durable: threads from a file capsule continue with their live history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-durable-import-"));
  const { faux, model, station } = createTestStation();
  const blueprint = blueprintFor(model.id);
  const legacyCapsule = await openFileCapsule({ blueprint, path: dir });
  const legacy = createAgent(station, blueprint, legacyCapsule, { tools: [webSearch] });
  faux.setResponses([
    fauxAssistantMessage("forgotten"),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "kept" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("kept answer"),
  ]);
  await legacy.handleMessage({ conversationId: "telegram:1", text: "before reset" });
  await legacy.resetConversation("telegram:1");
  await legacy.handleMessage({ conversationId: "telegram:1", text: "after reset" });
  await legacy.close();

  const capsule = await openFileCapsule({ blueprint, path: dir });
  const agent = await createDurableAgent(station, blueprint, capsule, {
    storage: await openNodeSqliteStorage(join(dir, "durable.sqlite")),
    tools: [webSearch],
  });
  assert.deepEqual((await agent.listThreads()).data.map((thread) => thread.threadId), ["telegram:1"]);
  assert.deepEqual(
    (await agent.readThread("telegram:1")).entries.map((entry) => entry.type),
    ["user", "assistant", "toolResult", "assistant"],
  );

  let request: Context | undefined;
  faux.setResponses([(context: Context) => ((request = context), fauxAssistantMessage("continued"))]);
  assert.equal((await agent.handleMessage({ conversationId: "telegram:1", text: "next" })).text, "continued");
  assert.equal(getCurrentSystemPrompt(request?.messages ?? []), "be brief");
  assert.equal(request?.messages[0]?.role, "system");
  assert.deepEqual(
    request?.messages.filter((message) => message.role === "user").map((message) => contentText(message.content, "")),
    ["after reset", "next"],
  );
  assert.equal(request?.messages.filter((message) => message.role === "system").length, 1, "no second baseline");
  await agent.close();

  // Reopening does not import again.
  const reopened = await createDurableAgent(station, blueprint, await openFileCapsule({ blueprint, path: dir }), {
    storage: await openNodeSqliteStorage(join(dir, "durable.sqlite")),
    tools: [webSearch],
  });
  assert.equal((await reopened.readThread("telegram:1")).entries.length, 6);
  await reopened.close();
});

test("durable: close ends waiting turns, cancels queued ones, and rejects new work", async () => {
  const started = deferred();
  const tool: Tool = { ...webSearch, execute: async (_input, { signal }) => (started.resolve(), waitForAbort(signal)) };
  const { agent, faux } = await createTestAgent({ tools: [tool] });
  faux.setResponses([fauxAssistantMessage([fauxToolCall(WEB_SEARCH, { query: "wait" })], { stopReason: "toolUse" })]);

  const current = agent.startTurn({ threadId: "chat:close", text: "one" });
  await started.promise;
  const queued = agent.startTurn({ threadId: "chat:close", text: "two" });
  const closing = agent.close();
  assert.strictEqual(agent.close(), closing);
  await assert.rejects(current.completed, /resumes when the station restarts/);
  await assert.rejects(queued.completed, /canceled/i);
  await closing;
  assert.throws(() => agent.startTurn({ threadId: "chat:close", text: "three" }), /shutting down/);
});
