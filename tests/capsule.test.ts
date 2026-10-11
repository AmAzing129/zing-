import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { defaultBlueprint } from "../src/blueprint";
import {
  createMemoryCapsule,
  defaultCapsulePath,
  openFileCapsule,
  slugBlueprintName,
} from "../src/capsule";
import { conversationLogPath, parseTranscript } from "../src/transcript";

test("slugBlueprintName and defaultCapsulePath put the kind under home/capsules", () => {
  assert.equal(slugBlueprintName("Alice Bot"), "alice-bot");
  assert.equal(defaultCapsulePath("zing", "/tmp/zing-home"), join("/tmp/zing-home", "capsules", "zing"));
});

test("openFileCapsule births an identity and wakes the same one next time", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-capsule-"));
  const blueprint = defaultBlueprint();
  const first = await openFileCapsule({ blueprint, path });
  const second = await openFileCapsule({ blueprint, path });

  assert.match(first.identity.agentId, /^agt_[0-9a-f]{32}$/);
  assert.equal(first.identity.blueprintName, "zing");
  assert.equal(second.identity.agentId, first.identity.agentId);
  assert.equal(JSON.parse(await readFile(join(path, "identity.json"), "utf8")).agentId, first.identity.agentId);
});

test("openFileCapsule on two directories creates two individuals", async () => {
  const blueprint = defaultBlueprint();
  const first = await openFileCapsule({ blueprint, path: await mkdtemp(join(tmpdir(), "zing-capsule-")) });
  const second = await openFileCapsule({ blueprint, path: await mkdtemp(join(tmpdir(), "zing-capsule-")) });
  assert.notEqual(first.identity.agentId, second.identity.agentId);
});

test("a disk capsule appends a jsonl transcript under channel/localId", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-capsule-"));
  const blueprint = defaultBlueprint();
  const first = await openFileCapsule({ blueprint, path });
  await first.appendConversation("telegram:1", [{ role: "user", content: "hi", timestamp: 1 }]);
  await first.appendConversation("telegram:1", [
    {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      api: "unknown",
      provider: "unknown",
      model: "grok-4.6",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    },
  ]);

  const log = conversationLogPath(path, "telegram:1");
  const text = await readFile(log, "utf8");
  const events = parseTranscript(text, log);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "user");
  assert.equal(events[1]?.type, "assistant");

  const second = await openFileCapsule({ blueprint, path });
  const messages = await second.loadConversation("telegram:1");
  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[1]?.role, "assistant");
});

test("reset is appended and later loads start after it", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-capsule-"));
  const capsule = await openFileCapsule({ blueprint: defaultBlueprint(), path });
  await capsule.appendConversation("telegram:1", [{ role: "user", content: "old", timestamp: 1 }]);
  await capsule.resetConversation("telegram:1");
  await capsule.appendConversation("telegram:1", [{ role: "user", content: "new", timestamp: 2 }]);

  const live = await capsule.loadConversation("telegram:1");
  assert.equal(live.length, 1);
  if (live[0]?.role === "user") {
    assert.equal(live[0].content, "new");
  }

  const events = parseTranscript(await readFile(conversationLogPath(path, "telegram:1"), "utf8"), "log");
  assert.deepEqual(
    events.map((event) => event.type),
    ["user", "reset", "user"],
  );
});

test("capsule can ensure, read, and list conversations", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-capsule-"));
  const capsule = await openFileCapsule({ blueprint: defaultBlueprint(), path });

  assert.deepEqual(await capsule.ensureConversation("thr_empty"), { created: true });
  assert.deepEqual(await capsule.ensureConversation("thr_empty"), { created: false });
  await capsule.appendConversation("telegram:a/b", [{ role: "user", content: "hello", timestamp: 1 }]);

  assert.deepEqual(await capsule.readConversationEvents("thr_empty"), []);
  assert.equal((await capsule.readConversationEvents("telegram:a/b"))?.[0]?.type, "user");
  assert.equal(await capsule.readConversationEvents("missing"), undefined);
  assert.deepEqual(
    (await capsule.listConversations()).map((conversation) => conversation.conversationId).sort(),
    ["telegram:a/b", "thr_empty"],
  );
});

test("createMemoryCapsule is a separate individual from disk", async () => {
  const capsule = createMemoryCapsule({ blueprintName: "zing", agentId: "agt_memory" });
  await capsule.appendConversation("stdio:once", [{ role: "user", content: "hi", timestamp: 1 }]);
  assert.equal(capsule.identity.agentId, "agt_memory");
  assert.equal((await capsule.loadConversation("stdio:once"))[0]?.role, "user");
  await capsule.resetConversation("stdio:once");
  assert.deepEqual(await capsule.loadConversation("stdio:once"), []);
});

test("openFileCapsule still reads a capsule written with definitionName", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-capsule-"));
  await writeFile(
    join(path, "identity.json"),
    JSON.stringify({
      agentId: "agt_legacy",
      definitionName: "zing",
      createdAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
    }),
  );
  const capsule = await openFileCapsule({ blueprint: defaultBlueprint(), path });
  assert.equal(capsule.identity.agentId, "agt_legacy");
  assert.equal(capsule.identity.blueprintName, "zing");
});

test("openFileCapsule rejects a newer identity schema", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-capsule-"));
  await writeFile(
    join(path, "identity.json"),
    JSON.stringify({
      agentId: "agt_old",
      blueprintName: "zing",
      createdAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 99,
    }),
  );
  await assert.rejects(openFileCapsule({ blueprint: defaultBlueprint(), path }), /unsupported schemaVersion/);
});

test("memory and file capsules share the same state contract", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-capsule-state-"));
  const capsules = [
    createMemoryCapsule({ blueprintName: "memory-state" }),
    await openFileCapsule({ blueprint: defaultBlueprint(), path }),
  ];

  for (const capsule of capsules) {
    assert.equal(await capsule.state.read("plugin/value.txt"), undefined);
    assert.equal(await capsule.state.create("plugin/value.txt", "first"), true);
    assert.equal(await capsule.state.create("plugin/value.txt", "ignored"), false);
    assert.equal(await capsule.state.read("plugin/value.txt"), "first");
    await capsule.state.write("plugin/value.txt", "second");
    assert.equal(await capsule.state.read("plugin/value.txt"), "second");
  }
  assert.equal(await readFile(join(path, "plugin", "value.txt"), "utf8"), "second");
});

test("capsule state rejects keys that can escape or alias its namespace", async () => {
  const state = createMemoryCapsule().state;
  for (const key of ["", "/absolute", "../outside", "plugin/../outside", "plugin\\outside", "plugin//value"]) {
    await assert.rejects(() => state.write(key, "nope"), /Invalid capsule state key/);
  }
});
