import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Api, Bot } from "grammy";

import telegram, { parseAllowedUserIds, splitMessage } from "../plugins/channels/telegram/index";
import type { ConversationHost } from "../src/agent";
import { createPluginRegistry, loadPlugin } from "../src/plugin/index";

const host: ConversationHost = {
  dispatch: async () => ({ text: "ok" }),
  handleMessage: async () => ({ text: "ok" }),
  resetConversation: () => {},
};

test("splitMessage keeps short text", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
});

test("splitMessage breaks on newline", () => {
  const text = `${"line one\n".repeat(300)}tail`;
  const chunks = splitMessage(text, 80);
  assert.ok(chunks.every((chunk) => chunk.length <= 80));
  assert.equal(chunks.join("").replaceAll("\n", ""), text.replaceAll("\n", ""));
  assert.ok(chunks.length > 1);
});

test("parseAllowedUserIds skips junk and treats empty as open", () => {
  assert.equal(parseAllowedUserIds(undefined), null);
  assert.deepEqual(parseAllowedUserIds("1, 2, nope, 3"), new Set([1, 2, 3]));
});

test("telegram plugin registers without starting the bot", () => {
  const registry = createPluginRegistry({ host });
  telegram(registry.api);
  assert.equal(registry.getChannel("telegram")?.id, "telegram");
});

test("telegram plugin loads through its directory entry", async () => {
  const registry = createPluginRegistry({ host });
  await loadPlugin(registry, fileURLToPath(new URL("../plugins/channels/telegram", import.meta.url)));
  assert.equal(registry.getChannel("telegram")?.id, "telegram");
});

test("telegram channel waits for its asynchronous stop before resolving", async () => {
  const methods = Bot.prototype as unknown as {
    start: () => Promise<void>;
    stop: () => Promise<void>;
  };
  const originalStart = methods.start;
  const originalStop = methods.stop;
  let finishStart!: () => void;
  let finishStop!: () => void;
  let markStarted!: () => void;
  let markStopStarted!: () => void;
  const startGate = new Promise<void>((resolve) => { finishStart = resolve; });
  const stopGate = new Promise<void>((resolve) => { finishStop = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const stopStarted = new Promise<void>((resolve) => { markStopStarted = resolve; });

  methods.start = async () => {
    markStarted();
    await startGate;
  };
  methods.stop = async () => {
    markStopStarted();
    finishStart();
    await stopGate;
  };

  try {
    const registry = createPluginRegistry({ host, env: { TELEGRAM_BOT_TOKEN: "123:test" } });
    telegram(registry.api);
    const channel = registry.getChannel("telegram");
    assert.ok(channel);
    const controller = new AbortController();
    const running = channel.start(controller.signal);
    await started;
    controller.abort();
    await stopStarted;

    let settled = false;
    void running.then(() => { settled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(settled, false);

    finishStop();
    await running;
  } finally {
    finishStart();
    finishStop();
    methods.start = originalStart;
    methods.stop = originalStop;
  }
});

test("telegram send splits long replies and addresses numeric chats by number", async () => {
  const methods = Api.prototype as unknown as { sendMessage: (chatId: number | string, text: string) => Promise<unknown> };
  const original = methods.sendMessage;
  const sent: Array<[number | string, number]> = [];
  methods.sendMessage = async (chatId, text) => { sent.push([chatId, text.length]); return {}; };
  try {
    const registry = createPluginRegistry({ host, env: { TELEGRAM_BOT_TOKEN: "123:test" } });
    telegram(registry.api);
    const channel = registry.getChannel("telegram");
    assert.ok(channel?.send);
    await channel.send({ conversationId: "telegram:-100", to: "-100", text: "x".repeat(5000) });
    await channel.send({ conversationId: "telegram:@news", to: "@news", text: "hi" });
  } finally {
    methods.sendMessage = original;
  }
  assert.deepEqual(sent, [[-100, 4096], [-100, 904], ["@news", 2]]);
});
