import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { toSamples, type TrajectoryRecord } from "../plugins/observers/trajectory/trajectory";
import { createMemoryCapsule } from "../src/capsule";
import { createPluginRegistry, loadPlugin, type CapsuleRef } from "../src/plugin/index";
import type { TurnContext } from "../src/plugin/types";
import type { ThreadEntry } from "../src/runtime";

const context: TurnContext = {
  provider: "test",
  model: "test-1",
  system: "Be brief.",
  tools: [{ name: "web_search", description: "Search.", parameters: { type: "object", properties: {} } }],
};

const turn = (
  conversationId: string,
  at: number,
  entries: ThreadEntry[],
  overrides: Partial<Extract<TrajectoryRecord, { type: "turn" }>> = {},
): TrajectoryRecord => ({
  v: 1,
  type: "turn",
  recordedAt: at,
  agentId: "agt",
  conversationId,
  status: "completed",
  context,
  entries,
  ...overrides,
});
const reset = (conversationId: string, at: number): TrajectoryRecord => ({ v: 1, type: "reset", recordedAt: at, agentId: "agt", conversationId });
const user = (at: number, text: string) => ({ type: "user" as const, at, content: text });
const reply = (at: number, text: string) => ({ type: "assistant" as const, at, content: [{ type: "text" as const, text }] });

test("trajectory plugin appends each observed turn and reset to an owner-only monthly file", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "zing-trajectory-")), "trajectories");
  const registry = createPluginRegistry({ env: { ZING_TRAJECTORY_DIR: dir } });
  await loadPlugin(registry, fileURLToPath(new URL("../plugins/observers/trajectory", import.meta.url)));
  const [listener] = registry.listListeners();
  assert.ok(listener);
  const capsule: CapsuleRef = { agentId: "agt_1", state: createMemoryCapsule({ blueprintName: "t", agentId: "agt_1" }).state };
  const signal = new AbortController().signal;
  const entries = [user(1, "hi"), reply(2, "hello")];

  await listener({ type: "turn", conversationId: "telegram:1", senderId: "42", capsule, status: "completed", entries, context }, signal);
  await listener({ type: "reset", conversationId: "telegram:1", capsule }, signal);

  const file = join(dir, `${new Date().toISOString().slice(0, 7)}.jsonl`);
  const lines = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(lines.map(({ recordedAt, ...line }) => (assert.equal(typeof recordedAt, "number"), line)), [
    { v: 1, type: "turn", agentId: "agt_1", conversationId: "telegram:1", senderId: "42", status: "completed", context, entries },
    { v: 1, type: "reset", agentId: "agt_1", conversationId: "telegram:1" },
  ]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
});

test("toSamples joins completed turns into one sample per uninterrupted conversation stretch", () => {
  const { samples, stats } = toSamples([
    turn("a", 1, [user(1, "q1"), reply(2, "a1")]),
    turn("b", 3, [user(3, "other"), reply(4, "chat")]),
    turn("a", 5, [user(5, "q2"), reply(6, "a2")]),
    turn("a", 5, [user(5, "q2"), reply(6, "a2")]),
    reset("a", 7),
    turn("a", 8, [user(8, "q3"), reply(9, "a3")]),
    turn("a", 10, [user(10, "boom"), { type: "assistant", at: 11, content: [], stopReason: "error" }], { status: "failed" }),
    turn("a", 12, [user(12, "q4"), reply(13, "a4")]),
    turn("a", 14, [user(14, "q5"), reply(15, "a5")], { context: { ...context, system: "Be thorough." } }),
    turn("a", 16, [user(16, "unanswered")]),
  ]);
  const transcript = (index: number) => samples[index]?.messages.map((message) => `${message.role}:${message.content}`);
  // Samples come out as their stretch ends: a reset, a failed turn, two context changes, then the open stretch.
  // The last stretch of "a" has no assistant reply, so it yields no sample.
  assert.deepEqual(transcript(0), ["system:Be brief.", "user:q1", "assistant:a1", "user:q2", "assistant:a2"]);
  assert.deepEqual(transcript(1), ["system:Be brief.", "user:q3", "assistant:a3"]);
  assert.deepEqual(transcript(2), ["system:Be brief.", "user:q4", "assistant:a4"]);
  assert.deepEqual(transcript(3), ["system:Be thorough.", "user:q5", "assistant:a5"]);
  assert.deepEqual(transcript(4), ["system:Be brief.", "user:other", "assistant:chat"]);
  assert.equal(samples.length, 5);
  assert.deepEqual(samples[0]?.tools, [
    { type: "function", function: { name: "web_search", description: "Search.", parameters: { type: "object", properties: {} } } },
  ]);
  assert.deepEqual(stats, { turns: 8, skipped: 1, duplicates: 1, samples: 5 });
});

test("toSamples keeps tool calls, tool results, and images, and drops thinking", () => {
  const { samples } = toSamples([
    turn("a", 1, [
      { type: "user", at: 1, content: [{ type: "text", text: "what is this?" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
      {
        type: "assistant",
        at: 2,
        content: [
          { type: "thinking", thinking: "private summary" },
          { type: "toolCall", id: "call_1", name: "web_search", arguments: { query: "cat" } },
        ],
      },
      { type: "toolResult", at: 3, toolCallId: "call_1", toolName: "web_search", isError: false, content: [{ type: "text", text: "a cat" }] },
      { type: "assistant", at: 4, content: [{ type: "thinking", thinking: "done" }, { type: "text", text: "A cat." }] },
    ]),
  ]);
  assert.deepEqual(samples[0]?.messages.slice(1), [
    {
      role: "user",
      content: [{ type: "text", text: "what is this?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"cat\"}" } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "a cat" },
    { role: "assistant", content: "A cat." },
  ]);
});
