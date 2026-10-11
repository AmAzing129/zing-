import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxProvider } from "@earendil-works/pi-ai";

import type { Blueprint } from "../src/blueprint";
import { createMemoryCapsule } from "../src/capsule";
import { createZingHost } from "../src/host";

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
