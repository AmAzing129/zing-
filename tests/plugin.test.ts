import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fauxProvider, Type } from "@earendil-works/pi-ai";

import type { ConversationHost } from "../src/agent";
import { createMemoryCapsule } from "../src/capsule";
import {
  createPluginRegistry,
  loadPlugin,
  loadPlugins,
  resolvePluginPaths,
  selectChannel,
  selectProvider,
} from "../src/plugin/index";
import type { ConversationEvent, ConversationListener } from "../src/plugin/index";

const fixtures = fileURLToPath(new URL("./fixtures/plugins", import.meta.url));

const host: ConversationHost = {
  handleMessage: async () => ({ text: "ok" }),
  resetConversation: () => {},
};

test("conversation listeners register immediately and unsubscribe idempotently from a live list", () => {
  const registry = createPluginRegistry({ host });
  const live = registry.listListeners();
  const events: ConversationEvent[] = [];
  const listener: ConversationListener = (event) => { events.push(event); };

  const unsubscribe = registry.api.onConversation(listener);
  assert.strictEqual(registry.listListeners(), live);
  assert.deepEqual(live, [listener]);
  unsubscribe();
  unsubscribe();
  assert.strictEqual(registry.listListeners(), live);
  assert.deepEqual(live, []);
});

test("registry rejects a blank or duplicate channel id", () => {
  const registry = createPluginRegistry({ host });
  assert.throws(() => registry.api.registerChannel({ id: "  ", start: async () => {} }), /id/);
  registry.api.registerChannel({ id: "echo", start: async () => {} });
  assert.throws(() => registry.api.registerChannel({ id: "echo", start: async () => {} }), /already registered/);
});

test("registry validates and de-duplicates generic tool names", () => {
  const registry = createPluginRegistry({ host });
  const tool = {
    name: "market__quote",
    description: "Get a quote",
    parameters: Type.Object({ symbol: Type.String() }),
    execute: async () => ({ text: "ok" }),
  };
  registry.api.registerTool(tool);
  assert.equal(registry.getTool("market__quote")?.description, "Get a quote");
  assert.deepEqual(registry.listTools().map((entry) => entry.name), ["market__quote"]);
  assert.throws(() => registry.api.registerTool(tool), /already registered/);
  assert.throws(() => registry.api.registerTool({ ...tool, name: "Market.quote" }), /Invalid tool name/);
  assert.throws(() => registry.api.registerTool({ ...tool, name: "skill" }), /Tool name skill is reserved/);
  assert.throws(() => registry.api.registerTool({ ...tool, name: "subagent" }), /Tool name subagent is reserved/);
  registry.api.registerTool({ ...tool, name: "web_search" });
  assert.equal(registry.getTool("web_search")?.name, "web_search");
});

test("loadPlugin registers a file, a directory, and a packaged plugin", async () => {
  const registry = createPluginRegistry({ host });
  await loadPlugin(registry, join(fixtures, "echo.ts"));
  await loadPlugin(registry, join(fixtures, "named"));
  await loadPlugin(registry, join(fixtures, "packaged"));
  assert.deepEqual(
    registry.listChannels().map((channel) => channel.id),
    ["echo", "named", "packaged"],
  );
});

test("loadPlugin rejects a module without a default function", async () => {
  const registry = createPluginRegistry({ host });
  await assert.rejects(loadPlugin(registry, join(fixtures, "broken.ts")), /default-export/);
});

test("loadPlugin rejects a missing path", async () => {
  const registry = createPluginRegistry({ host });
  await assert.rejects(loadPlugin(registry, join(fixtures, "missing.ts")), /not found/i);
});

test("loadPlugins closes disposers once in reverse order", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-plugin-close-"));
  const key = `zingClose${Date.now()}${Math.random()}`;
  (globalThis as Record<string, unknown>)[key] = [];
  const paths = ["one.ts", "two.ts"];
  for (const [index, path] of paths.entries()) {
    await writeFile(
      join(root, path),
      `export default function () { return () => (globalThis[${JSON.stringify(key)}]).push(${index + 1}) }`,
    );
  }

  const close = await loadPlugins(createPluginRegistry({ host }), paths, root);
  await close();
  await close();
  assert.deepEqual((globalThis as Record<string, unknown>)[key], [2, 1]);
  delete (globalThis as Record<string, unknown>)[key];
});

test("loadPlugins rolls back loaded plugins when a later plugin fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-plugin-rollback-"));
  const key = `zingRollback${Date.now()}${Math.random()}`;
  (globalThis as Record<string, unknown>)[key] = [];
  await writeFile(
    join(root, "one.ts"),
    `export default function () { return () => (globalThis[${JSON.stringify(key)}]).push("closed") }`,
  );
  await writeFile(join(root, "broken.ts"), `export default function () { throw new Error("factory failed") }`);

  await assert.rejects(loadPlugins(createPluginRegistry({ host }), ["one.ts", "broken.ts"], root), /factory failed/);
  assert.deepEqual((globalThis as Record<string, unknown>)[key], ["closed"]);
  delete (globalThis as Record<string, unknown>)[key];
});

test("resolvePluginPaths resolves local paths, preserves order, and removes duplicates", () => {
  const cwd = join(tmpdir(), "zing-project");
  assert.deepEqual(
    resolvePluginPaths(["./plugins/one", join(cwd, "plugins", "one"), "./plugins/two"], cwd),
    [join(cwd, "plugins", "one"), join(cwd, "plugins", "two")],
  );
});

test("selectChannel picks the only plugin or requires an explicit id", () => {
  const registry = createPluginRegistry({ host });
  assert.throws(() => selectChannel(registry), /No channel plugin loaded/);

  registry.api.registerChannel({ id: "stdio", start: async () => {} });
  registry.api.registerChannel({ id: "telegram", start: async () => {} });
  assert.equal(selectChannel(registry).id, "telegram");
  assert.equal(selectChannel(registry, "stdio").id, "stdio");

  registry.api.registerChannel({ id: "discord", start: async () => {} });
  assert.throws(() => selectChannel(registry), /Multiple channels/);
  assert.equal(selectChannel(registry, "discord").id, "discord");
  assert.throws(() => selectChannel(registry, "slack"), /Unknown channel: slack/);
});

test("loadPlugin can register a tool", async () => {
  const registry = createPluginRegistry({ host });
  await loadPlugin(registry, join(fixtures, "tool.ts"));
  assert.equal(registry.getTool("noop__tool")?.name, "noop__tool");
});

test("registry rejects a blank or duplicate provider pluginId", () => {
  const registry = createPluginRegistry({ host });
  const provider = fauxProvider().provider;
  assert.throws(() => registry.api.registerProvider({ pluginId: "  ", provider }), /pluginId/);
  registry.api.registerProvider({ pluginId: "xai", provider });
  assert.throws(() => registry.api.registerProvider({ pluginId: "xai", provider: fauxProvider().provider }), /already registered/);
});

test("selectProvider picks the only plugin or requires an explicit id", () => {
  const registry = createPluginRegistry({ host });
  assert.throws(() => selectProvider(registry), /No provider plugin loaded/);

  registry.api.registerProvider({ pluginId: "xai", provider: fauxProvider({ provider: "xai" }).provider });
  assert.equal(selectProvider(registry).pluginId, "xai");
  assert.equal(selectProvider(registry, "xai").pluginId, "xai");

  registry.api.registerProvider({ pluginId: "anthropic", provider: fauxProvider({ provider: "anthropic" }).provider });
  assert.throws(() => selectProvider(registry), /Multiple provider/);
  assert.equal(selectProvider(registry, "anthropic").pluginId, "anthropic");
  assert.throws(() => selectProvider(registry, "openai"), /Unknown provider: openai/);
});




test("loadPlugin resolves import 'zing' from outside the package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zing-user-plugin-"));
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  const file = join(dir, "outside.ts");
  await writeFile(
    file,
    `
import { conversationId } from "zing";

export default function (zing) {
  zing.registerTool({
    name: "outside__probe",
    description: "probe",
    parameters: {},
    execute: async () => ({ text: conversationId("outside", "probe") }),
  });
}
`,
  );

  const registry = createPluginRegistry({ host });
  await loadPlugin(registry, file);
  const tool = registry.getTool("outside__probe");
  assert.ok(tool);
  const capsule = createMemoryCapsule({ blueprintName: "plugin-test", agentId: "agt_test" });
  const output = await tool.execute({}, {
    signal: new AbortController().signal,
    conversationId: "test:1",
    capsule: { agentId: capsule.identity.agentId, state: capsule.state },
  });
  assert.equal(output.text, "outside:probe");
});
