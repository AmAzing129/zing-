import assert from "node:assert/strict";
import test from "node:test";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

import { CONTEXT_OMISSION_TEXT, estimateMessageList, fitMessages } from "../src/context";

test("context pruning keeps recent complete turns and never mutates the transcript", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: `old question ${"x".repeat(200)}`, timestamp: 1 },
    fauxAssistantMessage(fauxToolCall("lookup", { query: "old" }, { id: "old-call" }), {
      stopReason: "toolUse",
      timestamp: 2,
    }),
    {
      role: "toolResult",
      toolCallId: "old-call",
      toolName: "lookup",
      content: [{ type: "text", text: "old result" }],
      isError: false,
      timestamp: 3,
    },
    fauxAssistantMessage("old answer", { timestamp: 4 }),
    { role: "user", content: "recent question", timestamp: 5 },
    fauxAssistantMessage("recent answer", { timestamp: 6 }),
  ];
  const recent = messages.slice(4);
  const budget = estimateMessageList(recent) + Math.ceil(CONTEXT_OMISSION_TEXT.length / 4);

  const fitted = fitMessages(messages, budget);

  assert.equal(fitted[0]?.role, "user");
  assert.equal(fitted[0]?.role === "user" ? fitted[0].content : undefined, CONTEXT_OMISSION_TEXT);
  assert.deepEqual(fitted.slice(1), recent);
  assert.equal(messages.length, 6);
  assert.equal(messages[0]?.role === "user" ? messages[0].content : undefined, `old question ${"x".repeat(200)}`);
});

test("context pruning leaves an already fitting transcript unchanged", () => {
  const messages: AgentMessage[] = [
    { role: "user", content: "hello", timestamp: 1 },
    fauxAssistantMessage("hi", { timestamp: 2 }),
  ];

  assert.equal(fitMessages(messages, estimateMessageList(messages)), messages);
});
