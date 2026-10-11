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
  const after = await createDurableAgent(second.station, blueprintFor(second.model.id), capsule, {
    storage: await openNodeSqliteStorage(file),
    tools: [finishing],
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
  assert.deepEqual(
    (await after.readThread("telegram:1")).entries.map((entry) => entry.type),
    ["user", "assistant", "toolResult", "assistant", "toolResult", "assistant"],
  );
  await after.close();
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
