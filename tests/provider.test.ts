import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPluginRegistry, loadPlugin } from "../src/plugin/index";

test("deepseek plugin loads through its directory entry and serves the default model", async () => {
  const registry = createPluginRegistry({ env: { DEEPSEEK_API_KEY: "ds-secret" } });
  await loadPlugin(registry, fileURLToPath(new URL("../plugins/providers/deepseek", import.meta.url)));
  const entry = registry.getProvider("deepseek");
  assert.equal(entry?.getApiKey?.(), "ds-secret");
  assert.ok(entry?.provider.getModels().some((model) => model.id === "deepseek-v4-pro"));
});
