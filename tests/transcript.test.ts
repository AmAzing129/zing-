import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationLogPath,
  decodeEvents,
  encodeMessages,
  eventsAfterLastReset,
  formatEvents,
  parseTranscript,
  resetEvent,
  splitConversationId,
} from "../src/transcript";

test("conversation paths split channel and local id", () => {
  assert.deepEqual(splitConversationId("telegram:12345"), { channel: "telegram", localId: "12345" });
  assert.equal(conversationLogPath("/tmp/cap", "telegram:12345"), "/tmp/cap/conversations/telegram/12345.jsonl");
  assert.equal(conversationLogPath("/tmp/cap", "stdio:once"), "/tmp/cap/conversations/stdio/once.jsonl");
  assert.match(conversationLogPath("/tmp/cap", "telegram:a/b"), /telegram\/a%2Fb\.jsonl$/);
  assert.equal(conversationLogPath("/tmp/cap", "..:.."), "/tmp/cap/conversations/%2E%2E/%2E%2E.jsonl");
});

test("encode and decode keep user, assistant, and tool result content", () => {
  const events = encodeMessages([
    { role: "user", content: "weather?", timestamp: 1 },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "call-1", name: "web_search", arguments: { query: "weather" } }],
      api: "openai-responses",
      provider: "xai",
      model: "grok-4.6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "web_search",
      isError: false,
      content: [{ type: "text", text: "{\"results\":[]}" }],
      details: { results: [] },
      timestamp: 3,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "sunny" }],
      api: "openai-responses",
      provider: "xai",
      model: "grok-4.6",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 4,
    },
  ]);

  assert.deepEqual(
    events.map((event) => event.type),
    ["user", "assistant", "toolResult", "assistant"],
  );

  const messages = decodeEvents(events);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[2]?.role, "toolResult");
  if (messages[1]?.role === "assistant") {
    assert.equal(messages[1].content[0]?.type, "toolCall");
  }
  if (messages[2]?.role === "toolResult") {
    assert.equal(messages[2].toolName, "web_search");
    assert.deepEqual(messages[2].details, { results: [] });
  }
});

test("reset is an event and hydrate starts after the last one", () => {
  const events = [
    ...encodeMessages([{ role: "user", content: "old", timestamp: 1 }]),
    resetEvent(2),
    ...encodeMessages([{ role: "user", content: "new", timestamp: 3 }]),
  ];
  const live = eventsAfterLastReset(events);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.type, "user");
  const messages = decodeEvents(events);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.role, "user");
  if (messages[0]?.role === "user") {
    assert.equal(messages[0].content, "new");
  }
});

test("parseTranscript reads jsonl and rejects a newer version", () => {
  const text = formatEvents(encodeMessages([{ role: "user", content: "hi", timestamp: 1 }]));
  const events = parseTranscript(text, "mem");
  assert.equal(events[0]?.type, "user");
  assert.throws(() => parseTranscript('{"v":2,"type":"reset","at":1}\n', "mem"), /unsupported transcript version/);
});

test("parseTranscript ignores only an incomplete final line", () => {
  const complete = formatEvents(encodeMessages([{ role: "user", content: "hi", timestamp: 1 }]));
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(parseTranscript(`${complete}{"v":1`, "mem").length, 1);
  } finally {
    console.warn = originalWarn;
  }
  assert.throws(() => parseTranscript(`${complete}{bad}\n`, "mem"), /invalid JSON/);
});
