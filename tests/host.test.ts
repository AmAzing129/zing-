import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";

import type { Blueprint } from "../src/blueprint";
import { createMemoryCapsule } from "../src/capsule";
import { createZingHost } from "../src/host";

test("host closes acquired storage on constructor failure and preserves cleanup errors", async () => {
  for (const failsCleanup of [false, true]) {
    const storage = new MemoryStorage();
    let closes = 0;
    const cleanupError = new Error("storage cleanup failed");
    storage.close = async () => {
      closes++;
      if (failsCleanup) throw cleanupError;
    };
    const faux = fauxProvider({ models: [{ id: "host-model" }] });
    await assert.rejects(createZingHost({
      blueprint: { name: "broken", tools: [] },
      capsuleFactory: async () => createMemoryCapsule({ blueprintName: "broken" }),
      durableStorage: async () => storage,
      configureRegistry(registry) {
        registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
      },
    }), (error: unknown) => {
      if (failsCleanup) {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[0]), /has no model/);
        assert.strictEqual(error.errors[1], cleanupError);
      } else {
        assert.match(String(error), /has no model/);
      }
      return true;
    });
    assert.equal(closes, 1);
  }
});

test("createZingHost injects a capsule factory and closes idempotently", async () => {
  const faux = fauxProvider({ models: [{ id: "host-model" }] });
  const blueprint: Blueprint = { name: "host-test", model: "host-model", tools: [] };
  const capsule = createMemoryCapsule({ blueprintName: blueprint.name, agentId: "agt_host" });
  let requested: Blueprint | undefined;
  const host = await createZingHost({
    blueprint,
    capsuleFactory: async (candidate) => {
      requested = candidate;
      return capsule;
    },
    configureRegistry(registry) {
      registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
    },
  });

  assert.strictEqual(requested, blueprint);
  assert.equal(host.agent.agentId, "agt_host");
  const closing = host.close();
  assert.strictEqual(host.close(), closing);
  await closing;
  assert.throws(() => host.agent.startTurn({ threadId: "closed", text: "nope" }), /shutting down/);
});

test("createZingHost runs the durable runtime over the storage it is given", async () => {
  const faux = fauxProvider({ models: [{ id: "host-model" }] });
  const blueprint: Blueprint = { name: "durable-host", model: "host-model", tools: ["echo"] };
  const capsule = createMemoryCapsule({ blueprintName: blueprint.name, agentId: "agt_durable" });
  const conversations: string[] = [];
  let storageFor: unknown;
  const host = await createZingHost({
    blueprint,
    capsuleFactory: async () => capsule,
    durableStorage: async (candidate) => {
      storageFor = candidate;
      return new MemoryStorage();
    },
    configureRegistry(registry) {
      registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
      registry.api.registerTool({
        name: "echo",
        description: "Echo",
        parameters: Type.Object({ text: Type.String() }),
        execute: async (input, context) => {
          conversations.push(context.conversationId);
          return { text: String(input.text) };
        },
      });
    },
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("echoed"),
  ]);

  assert.strictEqual(storageFor, capsule);
  assert.equal(host.agent.agentId, "agt_durable");
  assert.equal((await host.agent.handleMessage({ conversationId: "telegram:9", text: "echo hi" })).text, "echoed");
  assert.deepEqual(conversations, ["telegram:9"]);
  await host.close();
  assert.throws(() => host.agent.startTurn({ threadId: "closed", text: "nope" }), /shutting down/);
});

test("createZingHost disposes loaded plugins when construction fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-host-cleanup-"));
  const key = `zingHostCleanup${Date.now()}${Math.random()}`;
  (globalThis as Record<string, unknown>)[key] = 0;
  await writeFile(
    join(root, "plugin.ts"),
    `export default function () { return () => { globalThis[${JSON.stringify(key)}] += 1 } }`,
  );

  try {
    await assert.rejects(
      createZingHost({
        blueprint: { name: "broken-host", model: "missing", tools: [] },
        capsuleFactory: async () => createMemoryCapsule({ blueprintName: "broken-host" }),
        pluginPaths: ["./plugin.ts"],
        cwd: root,
      }),
      /No provider plugin loaded/,
    );
    assert.equal((globalThis as Record<string, unknown>)[key], 1);
  } finally {
    delete (globalThis as Record<string, unknown>)[key];
  }
});
