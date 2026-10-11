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

import { createAgent } from "../src/agent";
import type { Blueprint } from "../src/blueprint";
import { createMemoryCapsule, openCapsule } from "../src/capsule";
import { CONTEXT_OMISSION_TEXT } from "../src/context";
import { createPluginRegistry } from "../src/plugin/index";
import type { ConversationEvent, ConversationListener, Tool, ToolContext } from "../src/plugin/index";
import type { Station } from "../src/station";

const WEB_SEARCH_TOOL_NAME = "web_search";
const webSearch: Tool = {
  name: WEB_SEARCH_TOOL_NAME,
  description: "Search the web",
  parameters: Type.Object({ query: Type.String() }),
  execute: async () => ({ text: JSON.stringify({ results: [{ title: "One", url: "https://one.example", snippet: "first" }] }) }),
};

function testBlueprint(modelId: string): Blueprint {
  return {
    name: "test",
    model: modelId,
    system: "be brief",
    tools: [WEB_SEARCH_TOOL_NAME],
  };
}

function createTestHarness(search: Tool = webSearch) {
  const faux = fauxProvider();
  const { model, models, station } = createTestStation(faux);
  const agent = createAgent(station, testBlueprint(model.id), undefined, { tools: [search] });
  return { agent, faux, model, models, station };
}

function createTestStation(faux: ReturnType<typeof fauxProvider>) {
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  if (!model) {
    throw new Error("missing faux model");
  }
  const station: Station = {
    resolveModel: (id) => (id === model.id ? model : { ...model, id, name: id }),
    streamFn: models.streamSimple.bind(models),
    getApiKey: () => undefined,
  };
  return { model, models, station };
}

test("prompt runs the pi loop through a tool call", async () => {
  const { agent, faux } = createTestHarness();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "zing" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("here is the answer"),
  ]);

  const result = await agent.handleMessage({ conversationId: "stdio:once", text: "what is zing" });
  assert.equal(result.text, "here is the answer");
});

test("an agent can run with no tools", async () => {
  const { faux, model, station } = createTestHarness();
  const blueprint: Blueprint = {
    name: "tool-free",
    model: model.id,
    system: "be brief",
    tools: [],
  };
  const agent = createAgent(station, blueprint);
  faux.setResponses([fauxAssistantMessage("plain answer")]);

  assert.equal((await agent.handleMessage({ conversationId: "stdio:none", text: "hello" })).text, "plain answer");
});


test("an agent requires an explicit model id", () => {
  const { station } = createTestHarness();
  let resolved = false;
  const watched: Station = { ...station, resolveModel: (id) => ((resolved = true), station.resolveModel(id)) };
  assert.throws(
    () => createAgent(watched, { name: "modelless", tools: [] }),
    /Blueprint modelless has no model\. Set model in agent\.yaml or MODEL=<id>\./,
  );
  assert.equal(resolved, false);
});


test("generic tools execute and persist structured details", async () => {
  const { faux, model, station } = createTestHarness();
  const seen: Record<string, unknown>[] = [];
  const tool: Tool = {
    name: "market__quote",
    description: "Get a market quote",
    parameters: Type.Object({ symbol: Type.String() }),
    execute: async (input) => {
      seen.push(input);
      return { text: "ACME is 42", details: { symbol: "ACME", price: 42 } };
    },
  };
  const blueprint: Blueprint = {
    name: "investor",
    model: model.id,
    system: "Use market tools.",
    tools: [tool.name],
  };
  const agent = createAgent(station, blueprint, undefined, { tools: [tool] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, { symbol: "ACME" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);

  assert.equal((await agent.handleMessage({ conversationId: "portfolio:1", text: "quote ACME" })).text, "done");
  assert.deepEqual(seen, [{ symbol: "ACME" }]);
  const toolResult = (await agent.readThread("portfolio:1")).entries.find((entry) => entry.type === "toolResult");
  assert.equal(toolResult?.type, "toolResult");
  assert.deepEqual(toolResult?.type === "toolResult" ? toolResult.details : undefined, {
    symbol: "ACME",
    price: 42,
  });
});

test("tools receive the conversation, sender, and capsule in their context", async () => {
  const { faux, model, station } = createTestHarness();
  const contexts: ToolContext[] = [];
  const tool: Tool = {
    name: "ctx__probe",
    description: "Inspect the tool context",
    parameters: Type.Object({}),
    execute: async (_input, context) => {
      contexts.push(context);
      return { text: "context captured" };
    },
  };
  const blueprint: Blueprint = {
    name: "context-probe",
    model: model.id,
    system: "Use the context probe.",
    tools: [tool.name],
  };
  const capsule = createMemoryCapsule({ blueprintName: blueprint.name });
  const agent = createAgent(station, blueprint, capsule, { tools: [tool] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("first done"),
    fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" }),
    fauxAssistantMessage("second done"),
  ]);

  await agent.handleMessage({ conversationId: "telegram:1", text: "first", senderId: "alice" });
  await agent.handleMessage({ conversationId: "telegram:1", text: "second", senderId: "bob" });

  assert.deepEqual(contexts.map((context) => context.senderId), ["alice", "bob"]);
  assert.deepEqual(contexts.map((context) => context.conversationId), ["telegram:1", "telegram:1"]);
  assert.deepEqual(contexts.map((context) => context.capsule.agentId), [agent.agentId, agent.agentId]);
  assert.ok(contexts.every((context) => context.capsule.state === capsule.state));
  assert.deepEqual(contexts.map((context) => context.signal.aborted), [false, false]);
});

test("cancel propagates to a generic tool", async () => {
  const { faux, model, station } = createTestHarness();
  let receivedSignal: AbortSignal | undefined;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const tool: Tool = {
    name: "market__wait",
    description: "Wait for a quote",
    parameters: Type.Object({}),
    execute: async (_input, { signal }) => {
      receivedSignal = signal;
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
      });
      return { text: "unreachable" };
    },
  };
  const blueprint: Blueprint = {
    name: "investor",
    model: model.id,
    system: "Use market tools.",
    tools: [tool.name],
  };
  const agent = createAgent(station, blueprint, undefined, { tools: [tool] });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" }),
  ]);

  const turn = agent.startTurn({ threadId: "portfolio:cancel", text: "wait" });
  await started;
  await agent.cancelTurn("portfolio:cancel", turn.turnId);
  await assert.rejects(turn.completed, /canceled/i);
  assert.equal(receivedSignal?.aborted, true);
});

test("the same conversation keeps history", async () => {
  const { agent, faux } = createTestHarness();
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

  assert.equal((await agent.handleMessage({ conversationId: "stdio:once", text: "hi" })).text, "first");
  assert.equal((await agent.handleMessage({ conversationId: "stdio:once", text: "again" })).text, "second");
});

test("concurrent messages in the same conversation run in arrival order", async () => {
  const { agent, faux } = createTestHarness();
  faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

  const first = agent.handleMessage({ conversationId: "telegram:1", text: "one" });
  const second = agent.handleMessage({ conversationId: "telegram:1", text: "two" });

  assert.deepEqual(
    (await Promise.all([first, second])).map((result) => result.text),
    ["first", "second"],
  );
});

test("startTurn streams stable message and tool events", async () => {
  const { agent, faux } = createTestHarness();
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "zing" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("streamed answer"),
  ]);
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const turn = agent.startTurn({ threadId: "web:1", text: "search" });
  turn.subscribe((event) => events.push(event));

  assert.equal((await turn.completed).text, "streamed answer");
  assert.equal(events[0]?.type, "turn/started");
  assert.ok(events.some((event) => event.type === "message/delta"));
  assert.ok(events.some((event) => event.type === "message/completed"));
  const toolStart = events.find((event) => event.type === "tool/started");
  const toolEnd = events.find((event) => event.type === "tool/completed");
  assert.equal(toolStart?.callId, toolEnd?.callId);
  assert.deepEqual(events.at(-1), {
    type: "turn/completed",
    threadId: "web:1",
    turnId: turn.turnId,
    status: "completed",
    result: { text: "streamed answer" },
  });
});

test("runtime opens, reads, lists, and resets threads", async () => {
  const { agent, faux } = createTestHarness();
  assert.deepEqual(await agent.openThread("web:history"), { threadId: "web:history", created: true });
  assert.deepEqual(await agent.openThread("web:history"), { threadId: "web:history", created: false });
  faux.setResponses([fauxAssistantMessage("remembered")]);
  await agent.startTurn({ threadId: "web:history", text: "hello" }).completed;

  assert.deepEqual(
    (await agent.readThread("web:history")).entries.map((entry) => entry.type),
    ["user", "assistant"],
  );
  assert.equal((await agent.listThreads()).data[0]?.threadId, "web:history");
  await agent.resetThread("web:history");
  assert.deepEqual((await agent.readThread("web:history")).entries, []);
  await assert.rejects(() => agent.readThread("missing"), /Thread not found/);
});

test("reset waits behind the active turn", async () => {
  let releaseSearch!: () => void;
  let searchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    searchStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseSearch = resolve;
  });
  const search: Tool = {
    ...webSearch,
    async execute() {
      searchStarted();
      await release;
      return { text: JSON.stringify({ results: [] }) };
    },
  };
  const { agent, faux } = createTestHarness(search);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "wait" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("finished"),
  ]);

  const turn = agent.startTurn({ threadId: "web:reset-order", text: "run" });
  await started;
  const reset = agent.resetThread("web:reset-order");
  releaseSearch();
  await turn.completed;
  await reset;
  assert.deepEqual((await agent.readThread("web:reset-order")).entries, []);
});

test("cancel aborts only the active turn and keeps the thread usable", async () => {
  let searchStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    searchStarted = resolve;
  });
  const search: Tool = {
    ...webSearch,
    execute: async (_input, { signal }) => {
      searchStarted();
      await new Promise<void>((_resolve, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal.aborted) {
          fail();
          return;
        }
        signal.addEventListener("abort", fail, { once: true });
      });
      return { text: JSON.stringify({ results: [] }) };
    },
  };
  const { agent, faux } = createTestHarness(search);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "wait" })], { stopReason: "toolUse" }),
  ]);
  const events: Array<{ type: string; status?: string }> = [];
  const turn = agent.startTurn({ threadId: "web:cancel", text: "run" });
  turn.subscribe((event) => events.push(event));
  await started;
  await agent.cancelTurn("web:cancel", turn.turnId);

  await assert.rejects(turn.completed, /canceled/i);
  assert.equal(events.at(-1)?.type, "turn/completed");
  assert.equal(events.at(-1)?.status, "canceled");

  faux.setResponses([fauxAssistantMessage("recovered")]);
  assert.equal((await agent.startTurn({ threadId: "web:cancel", text: "again" }).completed).text, "recovered");
});

test("a turn handle can cancel its queued turn before the model runs", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const search: Tool = {
    ...webSearch,
    execute: async (_input, { signal }) => {
      markStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { text: "unreachable" };
    },
  };
  const { agent, faux } = createTestHarness(search);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "wait" })], { stopReason: "toolUse" }),
  ]);

  const active = agent.startTurn({ threadId: "web:queued-cancel", text: "one" });
  await started;
  const queued = agent.startTurn({ threadId: "web:queued-cancel", text: "two" });
  const events: string[] = [];
  queued.subscribe((event) => events.push(event.type));
  queued.cancel();
  await agent.cancelTurn("web:queued-cancel", active.turnId);

  await assert.rejects(active.completed, /canceled/i);
  await assert.rejects(queued.completed, /canceled/i);
  assert.equal(faux.state.callCount, 1);
  assert.deepEqual(events, ["turn/completed"]);
});

test("a failed message does not block the next message in its conversation", async () => {
  const { agent, faux } = createTestHarness();
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "model failed" }),
    fauxAssistantMessage("recovered"),
  ]);

  const failed = agent.handleMessage({ conversationId: "telegram:1", text: "one" });
  const next = agent.handleMessage({ conversationId: "telegram:1", text: "two" });

  await assert.rejects(failed, /model failed/);
  assert.equal((await next).text, "recovered");
});

test("agent conversations are isolated and reset drops one thread", async () => {
  const { agent, faux } = createTestHarness();
  faux.setResponses([
    fauxAssistantMessage("a1"),
    fauxAssistantMessage("b1"),
    fauxAssistantMessage("a2"),
    fauxAssistantMessage("b-reset"),
  ]);

  assert.equal((await agent.handleMessage({ conversationId: "telegram:1", text: "hi" })).text, "a1");
  assert.equal((await agent.handleMessage({ conversationId: "telegram:2", text: "hi" })).text, "b1");
  assert.equal((await agent.handleMessage({ conversationId: "telegram:1", text: "again" })).text, "a2");
  await agent.resetConversation("telegram:2");
  assert.equal((await agent.handleMessage({ conversationId: "telegram:2", text: "new" })).text, "b-reset");
});

test("a disk capsule keeps identity and history after the process is recreated", async () => {
  const { faux, model, station } = createTestHarness();
  const path = await mkdtemp(join(tmpdir(), "zing-agent-capsule-"));
  const blueprint = testBlueprint(model.id);

  const firstCapsule = await openCapsule({ blueprint, path });
  const first = createAgent(station, blueprint, firstCapsule);
  faux.setResponses([fauxAssistantMessage("remembered")]);
  assert.equal((await first.handleMessage({ conversationId: "telegram:1", text: "hi" })).text, "remembered");

  const secondCapsule = await openCapsule({ blueprint, path });
  const second = createAgent(station, blueprint, secondCapsule);
  faux.setResponses([fauxAssistantMessage("still me")]);
  assert.equal(second.agentId, first.agentId);
  assert.equal((await second.handleMessage({ conversationId: "telegram:1", text: "again" })).text, "still me");
  const history = await secondCapsule.loadConversation("telegram:1");
  assert.deepEqual(
    history.map((message) => [message.role, contentText(message.content, "")]),
    [
      ["user", "hi"],
      ["assistant", "remembered"],
      ["user", "again"],
      ["assistant", "still me"],
    ],
  );
});

test("reset is kept in the capsule and a new process starts after it", async () => {
  const { faux, model, station } = createTestHarness();
  const path = await mkdtemp(join(tmpdir(), "zing-agent-capsule-"));
  const blueprint = testBlueprint(model.id);

  const first = createAgent(station, blueprint, await openCapsule({ blueprint, path }));
  faux.setResponses([fauxAssistantMessage("before"), fauxAssistantMessage("after")]);
  assert.equal((await first.handleMessage({ conversationId: "telegram:1", text: "hi" })).text, "before");
  await first.resetConversation("telegram:1");

  const capsule = await openCapsule({ blueprint, path });
  const second = createAgent(station, blueprint, capsule);
  assert.equal((await second.handleMessage({ conversationId: "telegram:1", text: "again" })).text, "after");

  const live = await capsule.loadConversation("telegram:1");
  assert.equal(live.length, 2);
  const opened = live[0];
  assert.equal(opened?.role, "user");
  const text =
    opened?.role === "user"
      ? typeof opened.content === "string"
        ? opened.content
        : opened.content[0]?.type === "text"
          ? opened.content[0].text
          : ""
      : "";
  assert.equal(text, "again");
});

test("long threads prune only the model context and keep the full transcript", async () => {
  const faux = fauxProvider({
    models: [{ id: "tiny-context", contextWindow: 512, maxTokens: 64 }],
  });
  const { model, station } = createTestStation(faux);
  const blueprint: Blueprint = {
    name: "long-lived",
    model: model.id,
    system: "Be brief.",
    tools: [],
  };
  const agent = createAgent(station, blueprint);
  const seen: string[][] = [];
  const systems: string[] = [];
  faux.setResponses(
    Array.from({ length: 10 }, (_, index) => (context: Context) => {
      const first = context.messages[0];
      systems.push(first?.role === "system" ? getCurrentSystemPrompt(context.messages) ?? "" : "");
      seen.push(context.messages.filter((message) => message.role !== "system").map((message) => contentText(message.content, "")));
      return fauxAssistantMessage(`answer-${index}`);
    }),
  );

  for (let index = 0; index < 10; index += 1) {
    await agent.handleMessage({
      conversationId: "chat:long",
      text: `turn-${index} ${"x".repeat(220)}`,
    });
  }

  const finalContext = seen.at(-1) ?? [];
  assert.deepEqual(new Set(systems), new Set(["Be brief."]), "every request keeps the system prompt");
  assert.equal(finalContext[0], CONTEXT_OMISSION_TEXT);
  assert.ok(!finalContext.some((text) => text.startsWith("turn-0 ")));
  assert.ok(finalContext.some((text) => text.startsWith("turn-9 ")));
  const history = await agent.readThread("chat:long");
  assert.equal(history.entries.length, 20);
  assert.equal(history.entries[0]?.type, "user");
  assert.match(history.entries[0]?.type === "user" ? contentText(history.entries[0].content, "") : "", /^turn-0 /);
});

test("an oversized user input fails before calling the model", async () => {
  const faux = fauxProvider({
    models: [{ id: "tiny-input", contextWindow: 256, maxTokens: 64 }],
  });
  const { model, station } = createTestStation(faux);
  const observed: ConversationEvent[] = [];
  const agent = createAgent(
    station,
    {
      name: "bounded-input",
      model: model.id,
      system: "Be brief.",
      tools: [],
    },
    undefined,
    { listeners: [(event) => { observed.push(event); }] },
  );

  await assert.rejects(
    agent.handleMessage({ conversationId: "chat:oversized", text: "x".repeat(2_000) }),
    /User input exceeded.*context budget/,
  );
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual((await agent.readThread("chat:oversized")).entries, []);
  await agent.drainObservers();
  assert.deepEqual(observed, []);
});

test("an oversized tool result stops before another model call", async () => {
  const faux = fauxProvider({
    models: [{ id: "tiny-tool-result", contextWindow: 256, maxTokens: 64 }],
  });
  const { model, station } = createTestStation(faux);
  const tool: Tool = {
    name: "data__expand",
    description: "Return a large result",
    parameters: Type.Object({}),
    execute: async () => ({ text: "x".repeat(2_000) }),
  };
  const agent = createAgent(
    station,
    {
      name: "bounded-tool-result",
      model: model.id,
      system: "Use the tool.",
      tools: [tool.name],
    },
    undefined,
    { tools: [tool] },
  );
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" }),
  ]);

  await assert.rejects(
    agent.handleMessage({ conversationId: "chat:large-tool-result", text: "expand" }),
    /Current turn exceeded.*context budget/,
  );
  assert.equal(faux.state.callCount, 1);
  const history = await agent.readThread("chat:large-tool-result");
  assert.equal(history.entries.length, 3);
  assert.equal(history.entries.at(-1)?.type, "toolResult");
});

test("the model-turn budget stops a repeating tool loop", async () => {
  const { faux, model, station } = createTestHarness();
  const agent = createAgent(station, testBlueprint(model.id), undefined, {
    tools: [webSearch], limits: { maxModelTurns: 2 },
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "one" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "two" })], { stopReason: "toolUse" }),
  ]);

  await assert.rejects(
    agent.handleMessage({ conversationId: "chat:model-budget", text: "loop" }),
    /2 model-turn limit/,
  );
  assert.equal(faux.state.callCount, 2);
});

test("the tool-call budget blocks excess calls before execution", async () => {
  const { faux, model, station } = createTestHarness();
  let executions = 0;
  const tool: Tool = {
    name: "counter__increment",
    description: "Increment a counter",
    parameters: Type.Object({}),
    execute: async () => {
      executions += 1;
      return { text: String(executions) };
    },
  };
  const blueprint: Blueprint = {
    name: "tool-budget",
    model: model.id,
    system: "Use the counter.",
    tools: [tool.name],
  };
  const agent = createAgent(station, blueprint, undefined, {
    tools: [tool],
    limits: { maxToolCalls: 1 },
  });
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall(tool.name, {}), fauxToolCall(tool.name, {})],
      { stopReason: "toolUse" },
    ),
  ]);

  await assert.rejects(
    agent.handleMessage({ conversationId: "chat:tool-budget", text: "twice" }),
    /1 tool-call limit/,
  );
  assert.equal(executions, 1);
});

test("the turn timeout settles even when a plugin ignores abort", async () => {
  const { faux, model, station } = createTestHarness();
  let receivedSignal: AbortSignal | undefined;
  const tool: Tool = {
    name: "wait__forever",
    description: "Never finish",
    parameters: Type.Object({}),
    execute: async (_input, { signal }) => {
      receivedSignal = signal;
      return new Promise<never>(() => {});
    },
  };
  const blueprint: Blueprint = {
    name: "timeout",
    model: model.id,
    system: "Use the wait tool.",
    tools: [tool.name],
  };
  const agent = createAgent(station, blueprint, undefined, {
    tools: [tool],
    limits: { turnTimeoutMs: 20 },
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" }),
  ]);
  const events: Array<{ type: string; status?: string }> = [];
  const turn = agent.startTurn({ threadId: "chat:timeout", text: "wait" });
  turn.subscribe((event) => events.push(event));

  await assert.rejects(turn.completed, /20ms timeout/);
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(events.at(-1)?.type, "turn/completed");
  assert.equal(events.at(-1)?.status, "failed");
});

test("conversation observers receive persisted completed turns and resets", async () => {
  const { faux, model, station } = createTestHarness();
  const events: ConversationEvent[] = [];
  const agent = createAgent(station, testBlueprint(model.id), undefined, {
    listeners: [(event) => { events.push(event); }],
  });
  faux.setResponses([fauxAssistantMessage("observed")]);

  await agent.handleMessage({ conversationId: "chat:observed", text: "hello", senderId: "alice" });
  await agent.drainObservers();
  const snapshot = await agent.readThread("chat:observed");
  assert.deepEqual(events.map(withoutCapsuleState), [{
    type: "turn",
    conversationId: "chat:observed",
    senderId: "alice",
    capsule: { agentId: agent.agentId },
    status: "completed",
    entries: snapshot.entries,
  }]);

  await agent.resetThread("chat:observed");
  await agent.drainObservers();
  assert.deepEqual(events.at(-1) && withoutCapsuleState(events.at(-1)!), {
    type: "reset",
    conversationId: "chat:observed",
    capsule: { agentId: agent.agentId },
  });
});

test("drainObservers waits for a new listener tail appended while draining", async () => {
  const { faux, model, station } = createTestHarness();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let markFirstStarted!: () => void;
  let markSecondStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  const order: string[] = [];
  let invocation = 0;
  const agent = createAgent(station, testBlueprint(model.id), undefined, {
    listeners: [async () => {
      invocation += 1;
      const current = invocation;
      order.push(current === 1 ? "first start" : "second start");
      if (current === 1) {
        markFirstStarted();
        await firstGate;
      } else {
        markSecondStarted();
        await secondGate;
      }
      order.push(current === 1 ? "first end" : "second end");
    }],
  });
  faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

  try {
    await agent.handleMessage({ conversationId: "chat:drain-race", text: "one" });
    await firstStarted;
    let drained = false;
    const draining = agent.drainObservers().then(() => { drained = true; });
    await agent.handleMessage({ conversationId: "chat:drain-race", text: "two" });
    releaseFirst();
    await secondStarted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(drained, false);
    releaseSecond();
    await draining;
    assert.deepEqual(order, ["first start", "first end", "second start", "second end"]);
  } finally {
    releaseFirst();
    releaseSecond();
  }
});

test("agent observes listeners registered and removed through a live registry list", async () => {
  const { faux, model, station } = createTestHarness();
  const registry = createPluginRegistry();
  const events: ConversationEvent[] = [];
  const agent = createAgent(station, testBlueprint(model.id), undefined, {
    listeners: registry.listListeners(),
  });
  const off = registry.api.onConversation((event) => { events.push(event); });
  faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

  await agent.handleMessage({ conversationId: "chat:live-registry", text: "one" });
  await agent.drainObservers();
  assert.equal(events.filter((event) => event.type === "turn").length, 1);

  off();
  off();
  await agent.handleMessage({ conversationId: "chat:live-registry", text: "two" });
  await agent.drainObservers();
  assert.equal(events.filter((event) => event.type === "turn").length, 1);
});

test("overlapping queued turns keep their own sender on observer events", async () => {
  const { faux, model, station } = createTestHarness();
  const senders: Array<string | undefined> = [];
  const agent = createAgent(station, testBlueprint(model.id), undefined, {
    listeners: [(event) => {
      if (event.type === "turn" && event.status === "completed") senders.push(event.senderId);
    }],
  });
  faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

  const alice = agent.handleMessage({ conversationId: "chat:sender-isolation", text: "one", senderId: "alice" });
  const bob = agent.handleMessage({ conversationId: "chat:sender-isolation", text: "two", senderId: "bob" });
  await Promise.all([alice, bob]);
  await agent.drainObservers();

  assert.deepEqual(senders, ["alice", "bob"]);
});

test("append failure rejects the turn without notifying observers", async () => {
  const { faux, model, station } = createTestHarness();
  const memoryCapsule = createMemoryCapsule({ blueprintName: "append-failure" });
  let appendCalls = 0;
  const capsule = {
    ...memoryCapsule,
    async appendConversation() {
      appendCalls += 1;
      throw new Error("persistence unavailable");
    },
  };
  const events: ConversationEvent[] = [];
  const agent = createAgent(station, testBlueprint(model.id), capsule, {
    listeners: [(event) => { events.push(event); }],
  });
  faux.setResponses([fauxAssistantMessage("fresh response")]);

  await assert.rejects(
    agent.handleMessage({ conversationId: "chat:append-failure", text: "fresh request" }),
    /persistence unavailable/,
  );
  await agent.drainObservers();

  assert.equal(faux.state.callCount, 1);
  assert.equal(appendCalls, 1);
  assert.equal(events.filter((event) => event.type === "turn").length, 0);
});

test("observers are serial per listener, parallel across listeners, and do not block replies", async () => {
  const { faux, model, station } = createTestHarness();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const starts: string[] = [];
  let secondListenerRan = false;
  const serial: ConversationListener = async (event) => {
    starts.push(event.conversationId);
    if (starts.length === 1) await gate;
  };
  const agent = createAgent(station, testBlueprint(model.id), undefined, {
    listeners: [serial, () => { secondListenerRan = true; throw new Error("isolated"); }],
  });
  faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  const first = agent.handleMessage({ conversationId: "chat:one", text: "one" });
  const second = agent.handleMessage({ conversationId: "chat:two", text: "two" });
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.text), ["one", "two"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ["chat:one"]);
  assert.equal(secondListenerRan, true);
  release();
  await agent.drainObservers();
  assert.deepEqual(starts, ["chat:one", "chat:two"]);
});

test("observer timeout aborts abandoned work and later events continue", async () => {
  const { faux, model, station } = createTestHarness();
  let firstSignal: AbortSignal | undefined;
  const seen: string[] = [];
  const agent = createAgent(station, testBlueprint(model.id), undefined, {
    observerTimeoutMs: 20,
    listeners: [async (event, signal) => {
      seen.push(event.conversationId);
      if (!firstSignal) {
        firstSignal = signal;
        await new Promise<never>(() => {});
      }
    }],
  });
  faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
  await agent.handleMessage({ conversationId: "chat:timeout-one", text: "one" });
  await agent.handleMessage({ conversationId: "chat:timeout-two", text: "two" });
  await agent.drainObservers();
  assert.equal(firstSignal?.aborted, true);
  assert.deepEqual(seen, ["chat:timeout-one", "chat:timeout-two"]);
});

test("failed and canceled persisted turns notify with their captured sender", async () => {
  const { faux, model, station } = createTestHarness();
  const events: ConversationEvent[] = [];
  let toolStarted!: () => void;
  const started = new Promise<void>((resolve) => { toolStarted = resolve; });
  const tool: Tool = {
    ...webSearch,
    execute: async (_input, { signal }) => {
      toolStarted();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return { text: "never" };
    },
  };
  const agent = createAgent(station, testBlueprint(model.id), undefined, {
    tools: [tool], listeners: [(event) => { events.push(event); }],
  });
  faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "failed" }),
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "wait" })], { stopReason: "toolUse" }),
  ]);
  await assert.rejects(agent.handleMessage({ conversationId: "chat:status", text: "fail", senderId: "alice" }), /failed/);
  const canceled = agent.startTurn({ threadId: "chat:status", text: "cancel", senderId: "bob" });
  await started;
  await agent.cancelTurn("chat:status", canceled.turnId);
  await assert.rejects(canceled.completed, /canceled/i);
  await agent.drainObservers();
  const turns = events.filter((event) => event.type === "turn");
  assert.deepEqual(turns.map(({ status, senderId }) => [status, senderId]), [["failed", "alice"], ["canceled", "bob"]]);
  assert.ok(turns.every((event) => event.entries.length > 0));
});

test("close cancels active and queued turns, drains observers, and rejects new work", async () => {
  const { faux, model, station } = createTestHarness();
  let markToolStarted!: () => void;
  let markObserverStarted!: () => void;
  let releaseObserver!: () => void;
  const toolStarted = new Promise<void>((resolve) => { markToolStarted = resolve; });
  const observerStarted = new Promise<void>((resolve) => { markObserverStarted = resolve; });
  const observerGate = new Promise<void>((resolve) => { releaseObserver = resolve; });
  const tool: Tool = {
    ...webSearch,
    execute: async (_input, { signal }) => {
      markToolStarted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { text: "never" };
    },
  };
  const capsule = createMemoryCapsule({ blueprintName: "closing" });
  const agent = createAgent(station, testBlueprint(model.id), capsule, {
    tools: [tool],
    listeners: [async (event) => {
      if (event.type === "turn") {
        markObserverStarted();
        await observerGate;
      }
    }],
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(WEB_SEARCH_TOOL_NAME, { query: "wait" })], { stopReason: "toolUse" }),
  ]);

  const active = agent.startTurn({ threadId: "chat:close", text: "one" });
  await toolStarted;
  const queued = agent.startTurn({ threadId: "chat:close", text: "two" });
  const closing = agent.close();
  assert.strictEqual(agent.close(), closing);

  try {
    await assert.rejects(active.completed, /canceled/i);
    await assert.rejects(queued.completed, /canceled/i);
    await observerStarted;
    let closed = false;
    void closing.then(() => { closed = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    assert.throws(() => agent.startTurn({ threadId: "chat:close", text: "three" }), /shutting down/);
  } finally {
    releaseObserver();
  }

  await closing;
  assert.ok((await agent.readThread("chat:close")).entries.length > 0);
});

function withoutCapsuleState(event: ConversationEvent) {
  return { ...event, capsule: { agentId: event.capsule.agentId } };
}
