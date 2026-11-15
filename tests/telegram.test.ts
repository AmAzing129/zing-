import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { Api, Bot, type Transformer } from "grammy";

import telegram, { COMMANDS, describeError, parseAllowedUserIds, splitMessage } from "../plugins/channels/telegram/index";
import type { ConversationHost } from "../src/agent";
import { createPluginRegistry, loadPlugin } from "../src/plugin/index";

// Keep the suite off the network: the channel registers its command menu before polling.
const originalSetMyCommands = Api.prototype.setMyCommands;
let setMyCommands: (commands: readonly unknown[]) => Promise<true> = async () => true;
before(() => {
  Api.prototype.setMyCommands = function (commands) {
    return setMyCommands(commands);
  };
});
after(() => {
  Api.prototype.setMyCommands = originalSetMyCommands;
});

const host: ConversationHost = {
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

test("telegram drains in-flight replies and keys requests by bot, chat and message", async () => {
  const originalStart = Bot.prototype.start;
  const originalStop = Bot.prototype.stop;
  const requests: string[] = [];
  const replies: string[] = [];
  try {
    for (const fail of [false, true]) {
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const handling = new Promise<void>((resolve) => { entered = resolve; });
      Bot.prototype.start = async function () {
        this.botInfo = {
          id: fail ? 456 : 123, is_bot: true, first_name: "Test", username: "test_bot",
          can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
          can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
          allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
        };
        const transform: Transformer = async (_previous, method, payload) => {
          if (method === "sendMessage") replies.push((payload as { text: string }).text);
          return { ok: true, result: true } as never;
        };
        this.api.config.use(transform);
        for (const [updateId, chatId, messageId] of [[7, 9, 1], [8, 9, 1], [7, 9, 2], [7, 10, 1]]) {
          await this.handleUpdate({
            update_id: updateId!,
            message: {
              message_id: messageId!, date: 1,
              from: { id: 1, is_bot: false, first_name: "User" },
              chat: { id: chatId!, type: "private", first_name: "User" }, text: "hello",
            },
          });
        }
      };
      Bot.prototype.stop = async () => {};
      const registry = createPluginRegistry({
        env: { TELEGRAM_BOT_TOKEN: "123:test" },
        host: {
          resetConversation() {},
          async handleMessage(message) {
            requests.push(message.requestId!);
            entered();
            await gate;
            if (fail) throw new Error("expected failure");
            return { text: "completed" };
          },
        },
      });
      telegram(registry.api);
      const controller = new AbortController();
      const running = registry.getChannel("telegram")!.start(controller.signal);
      await handling;
      controller.abort();
      let settled = false;
      void running.then(() => { settled = true; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      release();
      await running;
    }
    assert.deepEqual(requests, [
      "telegram:123:9:1", "telegram:123:9:1", "telegram:123:9:2", "telegram:123:10:1",
      "telegram:456:9:1", "telegram:456:9:1", "telegram:456:9:2", "telegram:456:10:1",
    ]);
    assert.deepEqual(replies, [...Array(4).fill("completed"), ...Array(4).fill("The request failed. Please try again later.")]);
  } finally {
    Bot.prototype.start = originalStart;
    Bot.prototype.stop = originalStop;
  }
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

test("telegram registers its command menu in the background and stops retrying when the channel stops", async () => {
  const originalStart = Bot.prototype.start;
  const originalStop = Bot.prototype.stop;
  const calls: unknown[] = [];
  let stopPolling!: () => void;
  try {
    Bot.prototype.start = () => new Promise<void>((resolve) => { stopPolling = resolve; });
    Bot.prototype.stop = async () => { stopPolling(); };
    const run = async () => {
      const registry = createPluginRegistry({ host, env: { TELEGRAM_BOT_TOKEN: "123:test" } });
      telegram(registry.api);
      const controller = new AbortController();
      const running = registry.getChannel("telegram")!.start(controller.signal);
      await new Promise<void>((resolve) => setImmediate(resolve));
      controller.abort();
      await running;
    };

    setMyCommands = async (commands) => (calls.push(commands), true);
    await run();
    assert.deepEqual(calls, [COMMANDS]);
    assert.deepEqual(COMMANDS.map(({ command }) => command), ["reset", "start"]);

    // A failing first attempt waits for a retry, and the stop cancels it: the channel still started and stopped.
    let attempts = 0;
    setMyCommands = async () => { attempts++; throw new Error("network down"); };
    await run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(attempts, 1);
  } finally {
    Bot.prototype.start = originalStart;
    Bot.prototype.stop = originalStop;
    setMyCommands = async () => true;
  }
});

test("telegram stops retrying its command menu when polling fails on its own", async () => {
  const originalStart = Bot.prototype.start;
  let attempts = 0;
  try {
    Bot.prototype.start = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      throw new Error("polling failed");
    };
    setMyCommands = async () => { attempts++; throw new Error("network down"); };
    const registry = createPluginRegistry({ host, env: { TELEGRAM_BOT_TOKEN: "123:test" } });
    telegram(registry.api);
    // The signal never aborts: only the channel's own exit can cancel the 2-second retry.
    await assert.rejects(registry.getChannel("telegram")!.start(new AbortController().signal), /polling failed/);
    await new Promise<void>((resolve) => setTimeout(resolve, 2_500));
    assert.equal(attempts, 1);
  } finally {
    Bot.prototype.start = originalStart;
    setMyCommands = async () => true;
  }
});

test("describeError keeps the bot token out of logs", () => {
  const nested = Object.assign(new Error("request to https://api.telegram.org/bot123:secret/setMyCommands failed"), {});
  assert.equal(describeError(nested, "123:secret"), "request to https://api.telegram.org/bot<redacted>/setMyCommands failed");
  assert.equal(describeError("plain", "123:secret"), "plain");
});
