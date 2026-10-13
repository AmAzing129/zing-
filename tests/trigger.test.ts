import assert from "node:assert/strict";
import test from "node:test";

import {
  contentText,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  Type,
  type Context,
} from "@earendil-works/pi-ai";

import { createAgent } from "../src/agent";
import type { Blueprint } from "../src/blueprint";
import { createMemoryCapsule } from "../src/capsule";
import { createDispatcher, ROUTES_KEY, runTriggerSources } from "../src/dispatcher";
import type { Channel, ConversationEvent, OutboundMessage, Tool, ToolContext, TriggerSource } from "../src/plugin/index";
import type { Station } from "../src/station";
import { parseTranscript } from "../src/transcript";

function harness() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  if (!model) throw new Error("missing faux model");
  const station: Station = {
    resolveModel: (id) => (id === model.id ? model : { ...model, id, name: id }),
    streamFn: models.streamSimple.bind(models),
    getApiKey: () => undefined,
  };
  return { faux, model, station };
}

function userTexts(context: Context): string[] {
  return context.messages.filter((message) => message.role === "user").map((message) => contentText(message.content, ""));
}

function recordingChannel(id: string): Channel & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    id,
    sent,
    start: async () => {},
    send: async (message) => { sent.push(message); },
  };
}

test("an automated trigger is framed for the model, stored raw, and labelled for clients", async () => {
  const { faux, model, station } = harness();
  const contexts: ToolContext[] = [];
  const events: ConversationEvent[] = [];
  const probe: Tool = {
    name: "probe",
    description: "probe",
    parameters: Type.Object({}),
    execute: async (_input, context) => { contexts.push(context); return { text: "ok" }; },
  };
  const blueprint: Blueprint = { name: "trigger", model: model.id, tools: ["probe"] };
  const capsule = createMemoryCapsule({ blueprintName: "trigger" });
  const agent = createAgent(station, blueprint, capsule, { tools: [probe], listeners: [(event) => { events.push(event); }] });
  const seen: string[][] = [];
  faux.setResponses([
    (context: Context) => { seen.push(userTexts(context)); return fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }); },
    fauxAssistantMessage("Time to stretch!"),
  ]);

  await agent.startTurn({
    threadId: "telegram:1",
    text: "Remind the user to stretch.",
    trigger: { kind: "schedule", source: "schedule:sch_1" },
  }).completed;
  await agent.drainObservers();

  const framed = seen[0]?.[0] ?? "";
  assert.match(framed, /^\[trigger kind=schedule source=schedule:sch_1 at=\d{4}-.*not typed by the user\]\nRemind the user to stretch\.$/);
  assert.deepEqual(contexts.map((context) => [context.trigger, context.senderId]), [[{ kind: "schedule", source: "schedule:sch_1" }, undefined]]);

  const stored = await capsule.readConversationEvents("telegram:1");
  assert.deepEqual(stored?.[0] && { type: stored[0].type, content: "content" in stored[0] ? stored[0].content : undefined, trigger: stored[0].type === "user" ? stored[0].trigger : undefined }, {
    type: "user",
    content: "Remind the user to stretch.",
    trigger: { kind: "schedule", source: "schedule:sch_1" },
  });
  const snapshot = await agent.readThread("telegram:1");
  assert.deepEqual(snapshot.entries[0], { type: "user", at: snapshot.entries[0]?.at, content: "Remind the user to stretch.", trigger: { kind: "schedule", source: "schedule:sch_1" } });
  assert.deepEqual(events.map((event) => event.type === "turn" ? event.trigger : undefined), [{ kind: "schedule", source: "schedule:sch_1" }]);

  // A fresh agent over the same capsule replays the identical framed text, followed by a plain user message.
  const reloaded = createAgent(station, blueprint, capsule, { tools: [probe] });
  const replayed: string[][] = [];
  faux.setResponses([(context: Context) => { replayed.push(userTexts(context)); return fauxAssistantMessage("Sure."); }]);
  await reloaded.handleMessage({ conversationId: "telegram:1", text: "thanks" });
  assert.deepEqual(replayed[0], [framed, "thanks"]);
  const users = (await reloaded.readThread("telegram:1")).entries.filter((entry) => entry.type === "user");
  assert.deepEqual(users.map((entry) => entry.trigger), [{ kind: "schedule", source: "schedule:sch_1" }, undefined]);
});

test("trigger metadata is validated before a turn starts", () => {
  const { model, station } = harness();
  const agent = createAgent(station, { name: "v", model: model.id, tools: [] });
  assert.throws(() => agent.startTurn({ threadId: "t", text: "x", senderId: "alice", trigger: { kind: "webhook" } }), /cannot carry a senderId/);
  assert.throws(() => agent.startTurn({ threadId: "t", text: "x", trigger: { kind: "Bad Kind" } }), /Invalid trigger kind/);
});

test("parseTranscript keeps trigger metadata and rejects malformed trigger events", () => {
  const line = JSON.stringify({ v: 1, type: "user", at: 1, content: "ping", trigger: { kind: "webhook", source: "webhook:ci" } });
  assert.deepEqual(parseTranscript(`${line}\n`, "t"), [{ v: 1, type: "user", at: 1, content: "ping", trigger: { kind: "webhook", source: "webhook:ci" } }]);
  const blocks = JSON.stringify({ v: 1, type: "user", at: 1, content: [{ type: "text", text: "x" }], trigger: { kind: "webhook" } });
  assert.throws(() => parseTranscript(`${blocks}\n`, "t"), /trigger content must be a string/);
  const message = JSON.stringify({ v: 1, type: "user", at: 1, content: "x", trigger: { kind: "message" } });
  assert.throws(() => parseTranscript(`${message}\n`, "t"), /plain user events/);
});

test("a message trigger's route is remembered and reused by later triggers, across dispatcher restarts", async () => {
  const { faux, model, station } = harness();
  const capsule = createMemoryCapsule({ blueprintName: "route" });
  const agent = createAgent(station, { name: "route", model: model.id, tools: [] }, capsule);
  const telegram = recordingChannel("telegram");
  const channels = new Map<string, Channel>([["telegram", telegram], ["mute", { id: "mute", start: async () => {} }]]);
  const options = { agent, state: capsule.state, getChannel: (id: string) => channels.get(id) };
  faux.setResponses([fauxAssistantMessage("hello alice"), fauxAssistantMessage("stretch now"), fauxAssistantMessage("   ")]);

  const first = createDispatcher(options);
  await first.dispatch({ kind: "message", conversationId: "telegram:42", text: "hi", senderId: "7", deliver: { channel: "telegram", to: "42" } });
  assert.deepEqual(JSON.parse((await capsule.state.read(ROUTES_KEY)) ?? "{}"), { "telegram:42": { channel: "telegram", to: "42" } });

  const restarted = createDispatcher(options);
  const result = await restarted.dispatch({ kind: "schedule", source: "schedule:sch_1", conversationId: "telegram:42", text: "stretch", deliver: "conversation" });
  assert.equal(result.text, "stretch now");
  // A blank reply is silence: the turn runs and persists, but nothing is sent.
  await restarted.dispatch({ kind: "schedule", conversationId: "telegram:42", text: "only if needed", deliver: "conversation" });
  assert.deepEqual(telegram.sent, [
    { conversationId: "telegram:42", to: "42", text: "hello alice" },
    { conversationId: "telegram:42", to: "42", text: "stretch now" },
  ]);
  assert.equal((await agent.readThread("telegram:42")).entries.filter((entry) => entry.type === "user").length, 3);

  // A route that cannot send is refused before any turn runs.
  await assert.rejects(restarted.dispatch({ kind: "message", conversationId: "mute:1", text: "x", deliver: { channel: "mute", to: "1" } }), /cannot send/);
  await assert.rejects(agent.readThread("mute:1"), /Thread not found/);
});

test("a trigger for a conversation with no route still runs and stays in the conversation", async () => {
  const { faux, model, station } = harness();
  const capsule = createMemoryCapsule({ blueprintName: "routeless" });
  const agent = createAgent(station, { name: "routeless", model: model.id, tools: [] }, capsule);
  const dispatcher = createDispatcher({ agent, state: capsule.state, getChannel: () => undefined });
  faux.setResponses([fauxAssistantMessage("noted")]);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await dispatcher.dispatch({ kind: "webhook", conversationId: "web:1", text: "build failed", deliver: "conversation" })).text, "noted");
  } finally {
    console.warn = warn;
  }
  assert.equal((await agent.readThread("web:1")).entries.length, 2);
});

test("runTriggerSources stops every source when one fails and rethrows that failure", async () => {
  const stopped: string[] = [];
  const waiter = (id: string): TriggerSource => ({
    id,
    start: (signal) => new Promise<void>((resolve) => signal.addEventListener("abort", () => { stopped.push(id); resolve(); }, { once: true })),
  });
  const failing: TriggerSource = { id: "broken", start: async () => { await Promise.resolve(); throw new Error("port in use"); } };
  await assert.rejects(runTriggerSources([waiter("telegram"), failing, waiter("schedule")], new AbortController().signal), (error: Error) => {
    assert.match(error.message, /broken failed/);
    assert.match(String((error.cause as Error).message), /port in use/);
    return true;
  });
  assert.deepEqual(stopped.sort(), ["schedule", "telegram"]);

  const shutdown = new AbortController();
  const running = runTriggerSources([waiter("a"), waiter("b")], shutdown.signal);
  shutdown.abort();
  await running;
});
