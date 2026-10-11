import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import xai, { XAI_PLUGIN_ID } from "../plugins/providers/xai/index";
import { createPluginRegistry, loadPlugin } from "../src/plugin/index";

test("xai plugin registers as a station provider", () => {
  const registry = createPluginRegistry();
  xai(registry.api);
  const entry = registry.getProvider(XAI_PLUGIN_ID);
  assert.equal(entry?.pluginId, "xai");
  assert.equal(entry?.provider.id, "xai");
});

test("xai plugin reads XAI_API_KEY only when asked", () => {
  const registry = createPluginRegistry({ env: { XAI_API_KEY: "xai-secret" } });
  xai(registry.api);
  assert.equal(registry.getProvider("xai")?.getApiKey?.(), "xai-secret");
});

test("xai plugin loads through its directory entry", async () => {
  const registry = createPluginRegistry();
  await loadPlugin(registry, fileURLToPath(new URL("../plugins/providers/xai", import.meta.url)));
  assert.equal(registry.getProvider("xai")?.pluginId, "xai");
});
