import assert from "node:assert/strict";
import test from "node:test";

import type { ConversationHost } from "../src/agent";
import { registerStdioChannel } from "../src/channels/stdio";
import { createPluginRegistry } from "../src/plugin/index";

test("stdio channel sends the message and prints the reply", async () => {
  const seen: string[] = [];
  const host: ConversationHost = {
    dispatch: async () => ({ text: "unused" }),
    handleMessage: async (message) => {
      seen.push(message.conversationId, message.text);
      return { text: "ok" };
    },
    resetConversation: () => {},
  };
  const registry = createPluginRegistry({ host });
  registerStdioChannel(registry.api, { message: "hello" });
  const channel = registry.getChannel("stdio");
  assert.ok(channel);

  const lines: string[] = [];
  const original = console.log;
  console.log = (value) => {
    lines.push(String(value));
  };
  try {
    await channel.start(new AbortController().signal);
  } finally {
    console.log = original;
  }

  assert.deepEqual(seen, ["stdio:once", "hello"]);
  assert.deepEqual(lines, ["ok"]);
});

test("stdio channel requires a message", async () => {
  const registry = createPluginRegistry({
    host: {
      dispatch: async () => ({ text: "unused" }),
      handleMessage: async () => ({ text: "ok" }),
      resetConversation: () => {},
    },
  });
  registerStdioChannel(registry.api);
  const channel = registry.getChannel("stdio");
  assert.ok(channel);
  await assert.rejects(() => channel.start(new AbortController().signal), /stdio/);
});

test("stdio channel refuses work after its host signal is aborted", async () => {
  const registry = createPluginRegistry({
    host: {
      dispatch: async () => ({ text: "unused" }),
      handleMessage: async () => ({ text: "unreachable" }),
      resetConversation: () => {},
    },
  });
  registerStdioChannel(registry.api, { message: "hello" });
  const channel = registry.getChannel("stdio");
  assert.ok(channel);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => channel.start(controller.signal), /aborted/i);
});
