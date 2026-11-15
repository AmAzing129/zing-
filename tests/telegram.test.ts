import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Bot, type Transformer } from "grammy";

import telegram, { IMAGE_FAILED_TEXT, MAX_IMAGE_BYTES, parseAllowedUserIds, splitMessage } from "../plugins/channels/telegram/index";
import type { ConversationHost } from "../src/agent";
import { createPluginRegistry, loadPlugin, type IncomingMessage } from "../src/plugin/index";

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

test("telegram sends photos and image files with their caption, and skips other files", async () => {
  const originalStart = Bot.prototype.start;
  const originalStop = Bot.prototype.stop;
  const originalFetch = globalThis.fetch;
  const received: IncomingMessage[] = [];
  const replies: string[] = [];
  const downloads: string[] = [];
  const from = { id: 1, is_bot: false, first_name: "User" };
  const chat = { id: 9, type: "private" as const, first_name: "User" };
  try {
    globalThis.fetch = (async (url: string | URL) => {
      downloads.push(String(url));
      return new Response(new Uint8Array([1, 2, 3]));
    }) as typeof fetch;
    Bot.prototype.start = async function () {
      this.botInfo = {
        id: 123, is_bot: true, first_name: "Test", username: "test_bot",
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
        allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
      };
      const transform: Transformer = async (_previous, method, payload) => {
        if (method === "sendMessage") replies.push((payload as { text: string }).text);
        if (method === "getFile") {
          const { file_id } = payload as { file_id: string };
          return { ok: true, result: { file_id, file_unique_id: file_id, file_path: `photos/${file_id}` } } as never;
        }
        return { ok: true, result: true } as never;
      };
      this.api.config.use(transform);
      const photo = (file_id: string, file_size: number) => ({ file_id, file_unique_id: file_id, width: 1, height: 1, file_size });
      const document = (file_id: string, mime_type: string, file_size = 3) => ({ file_id, file_unique_id: file_id, mime_type, file_size });
      const messages = [
        { photo: [photo("small", 1), photo("large", 3)], caption: "what is this?" },
        { photo: [photo("bare", 3)] },
        { document: document("png", "image/png"), caption: "and this?" },
        { document: document("pdf", "application/pdf"), caption: "ignored" },
        { photo: [photo("huge", MAX_IMAGE_BYTES + 1)], caption: "too big" },
      ];
      for (const [index, message] of messages.entries()) {
        await this.handleUpdate({ update_id: index, message: { message_id: index, date: 1, from, chat, ...message } as never });
      }
    };
    Bot.prototype.stop = async () => {};
    const registry = createPluginRegistry({
      env: { TELEGRAM_BOT_TOKEN: "123:test" },
      host: {
        resetConversation() {},
        async handleMessage(message) {
          received.push(message);
          return { text: "seen" };
        },
      },
    });
    telegram(registry.api);
    await registry.getChannel("telegram")!.start(new AbortController().signal);

    const image = (mimeType: string) => [{ type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType }];
    assert.deepEqual(received.map(({ text, images, requestId }) => ({ text, images, requestId })), [
      { text: "what is this?", images: image("image/jpeg"), requestId: "telegram:123:9:0" },
      { text: "", images: image("image/jpeg"), requestId: "telegram:123:9:1" },
      { text: "and this?", images: image("image/png"), requestId: "telegram:123:9:2" },
    ]);
    assert.deepEqual(downloads, ["large", "bare", "png"].map((id) => `https://api.telegram.org/file/bot123:test/photos/${id}`));
    assert.deepEqual(replies, ["seen", "seen", "seen", IMAGE_FAILED_TEXT]);
  } finally {
    Bot.prototype.start = originalStart;
    Bot.prototype.stop = originalStop;
    globalThis.fetch = originalFetch;
  }
});
