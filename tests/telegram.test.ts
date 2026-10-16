import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Bot, type Transformer } from "grammy";

import telegram, { parseAllowedUserIds, splitMessage } from "../plugins/channels/telegram/index";
import { createApprovals } from "../plugins/channels/telegram/approvals";
import type { ConversationHost } from "../src/agent";
import { createPluginRegistry, loadPlugin } from "../src/plugin/index";

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
    assert.deepEqual(replies, [...Array(4).fill("completed"), ...Array(4).fill("调用失败，请稍后再试。")]);
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

test("telegram approvals wait for the asker's tap in their chat, and expire with the turn", async () => {
  const sent: Array<{ chatId: number; text: string; data: string[] }> = [];
  const edits: string[] = [];
  const approvals = createApprovals({
    send: async (chatId, text, buttons) => (sent.push({ chatId, text, data: buttons.map((b) => b.data) }), sent.length),
    edit: async (_chatId, _messageId, text) => void edits.push(text.split("\n\n").at(-1) ?? ""),
  });
  const request = { tool: "notion__create", description: "Create", input: { title: "Plan" } };

  const idle = approvals.untilAsking();
  let woke = false;
  void idle.asking.then(() => (woke = true));
  const first = approvals.ask(7, 1, request, new AbortController().signal);
  await Promise.resolve();
  assert.equal(woke, true, "a waiting update handler lets go once a question is open");
  await new Promise((resolve) => setImmediate(resolve));
  const [approve, decline] = sent[0]?.data ?? [];
  assert.match(sent[0]?.text ?? "", /notion__create[\s\S]*"title": "Plan"/);
  assert.equal(approvals.answer(approve ?? "", 8, 1), "expired", "another chat cannot answer");
  // In a group, everyone sees the buttons; another member's tap leaves the question open.
  assert.equal(approvals.answer(approve ?? "", 7, 2), "not-asker");
  assert.equal(approvals.answer(decline ?? "", 7, 1), "answered");
  assert.equal(await first, false);
  assert.equal(approvals.answer(approve ?? "", 7, 1), "expired", "an answered question stays answered");

  const turn = new AbortController();
  const second = approvals.ask(7, 1, request, turn.signal);
  await new Promise((resolve) => setImmediate(resolve));
  turn.abort();
  assert.equal(await second, false);
  const third = approvals.ask(7, 1, request, new AbortController().signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approvals.answer(sent[2]?.data[0] ?? "", 7, 1), "answered");
  assert.equal(await third, true);
  assert.deepEqual(edits, ["已拒绝。", "已失效：这轮对话已结束。", "已允许。"]);
});

test("telegram lets go of a message update while it waits, so the button tap can arrive", { timeout: 5_000 }, async () => {
  const originalStart = Bot.prototype.start;
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const from = { id: 1, is_bot: false, first_name: "User" };
  const chat = { id: 9, type: "private" as const, first_name: "User" };
  try {
    // Like grammY's polling: one update at a time, each awaited before the next.
    Bot.prototype.start = async function () {
      this.botInfo = {
        id: 123, is_bot: true, first_name: "Test", username: "test_bot",
        can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
        can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
        allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
      };
      const transform: Transformer = async (_previous, method, payload) => {
        calls.push({ method, payload: payload as Record<string, unknown> });
        const result = method === "sendMessage" ? { message_id: calls.length, date: 1, chat } : true;
        return { ok: true, result } as never;
      };
      this.api.config.use(transform);
      await this.handleUpdate({ update_id: 1, message: { message_id: 1, date: 1, from, chat, text: "create it" } });
      const question = calls.find((call) => call.method === "sendMessage")?.payload;
      const markup = question?.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
      const tap = (id: string, by: typeof from) => ({
        id, from: by, chat_instance: "c", data: markup.inline_keyboard[0]?.[0]?.callback_data ?? "",
        message: { message_id: 2, date: 1, chat, text: "question" },
      });
      // Someone else in the chat taps first; only the asker's tap decides.
      await this.handleUpdate({ update_id: 2, callback_query: tap("q0", { ...from, id: 2, first_name: "Other" }) });
      await this.handleUpdate({ update_id: 3, callback_query: tap("q1", from) });
    };
    const registry = createPluginRegistry({
      env: { TELEGRAM_BOT_TOKEN: "123:test" },
      host: {
        resetConversation() {},
        async handleMessage(message) {
          const request = { tool: "notion__create", description: "Create", input: { title: "Plan" } };
          const approved = await message.approve?.(request, new AbortController().signal);
          return { text: `approved: ${String(approved)}` };
        },
      },
    });
    telegram(registry.api);
    await registry.getChannel("telegram")!.start(new AbortController().signal);

    const texts = calls.filter((call) => call.method === "sendMessage").map((call) => call.payload.text);
    assert.match(String(texts[0]), /需要你确认才会执行：notion__create/);
    assert.equal(texts.at(-1), "approved: true");
    assert.deepEqual(
      calls.filter((call) => call.method === "answerCallbackQuery").map((call) => call.payload.text),
      ["只有发起这次请求的人能确认。", undefined],
    );
    assert.match(String(calls.find((call) => call.method === "editMessageText")?.payload.text), /已允许。$/);
  } finally {
    Bot.prototype.start = originalStart;
  }
});
