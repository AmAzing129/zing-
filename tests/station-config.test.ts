import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPluginRegistry, loadPlugins } from "../src/plugin/index";
import {
  findStationConfig,
  loadStationConfig,
  parseStationConfig,
} from "../src/station-config";

test("station config resolves ordered plugin paths relative to its own file", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-station-"));
  const configDir = join(root, "config");
  await mkdir(configDir);
  const path = join(configDir, "station.yaml");
  await writeFile(
    path,
    "plugins:\n  - ../plugins/xai\n  - ../plugins/telegram\nchannel: telegram\nprovider: xai\n",
  );

  assert.deepEqual(await loadStationConfig(path), {
    plugins: [join(root, "plugins", "xai"), join(root, "plugins", "telegram")],
    channel: "telegram",
    provider: "xai",
  });
});

test("station config selects the agent runtime", () => {
  assert.equal(parseStationConfig({ plugins: [], runtime: "durable" }).runtime, "durable");
  assert.equal(parseStationConfig({ plugins: [] }).runtime, undefined);
  assert.throws(() => parseStationConfig({ plugins: [], runtime: "fast" }), /runtime must be one of legacy, durable/);
});

test("station config rejects unknown fields, invalid lists, and duplicate resolved paths", () => {
  assert.throws(() => parseStationConfig({ plugins: [], model: "grok" }), /unknown station field model/);
  assert.throws(() => parseStationConfig({ plugins: "./one" }), /plugins must be a list/);
  assert.throws(
    () => parseStationConfig({ plugins: ["./one", "one"] }, "station.yaml", "/tmp/config"),
    /duplicate plugin path/,
  );
});

test("findStationConfig prefers explicit or env paths, then cwd, then home", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-find-station-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  await mkdir(cwd);
  await mkdir(home);
  await writeFile(join(cwd, "station.yaml"), "plugins: []\n");
  await writeFile(join(home, "station.yml"), "plugins: []\n");

  assert.equal(
    await findStationConfig({ cwd, home, explicit: "./custom.yaml", env: { ZING_STATION: "./env.yaml" } }),
    join(cwd, "custom.yaml"),
  );
  assert.equal(
    await findStationConfig({ cwd, home, env: { ZING_STATION: "./env.yaml" } }),
    join(cwd, "env.yaml"),
  );
  assert.equal(await findStationConfig({ cwd, home, env: {} }), join(cwd, "station.yaml"));
  assert.equal(
    await findStationConfig({ cwd: join(root, "empty"), home, env: {} }),
    join(home, "station.yml"),
  );
});

test("the checked-in station enables the default local plugin set", async () => {
  const path = fileURLToPath(new URL("../station.yaml", import.meta.url));
  const station = await loadStationConfig(path);
  const registry = createPluginRegistry({ env: {} });
  const close = await loadPlugins(registry, station.plugins);

  assert.equal(station.channel, "telegram");
  assert.equal(registry.getProvider("deepseek")?.pluginId, "deepseek");
  assert.equal(registry.getChannel("telegram")?.id, "telegram");
  assert.deepEqual(registry.listTools().map((tool) => tool.name), ["web_search", "memory_search", "memory_save"]);
  assert.equal(registry.listListeners().length, 1);
  await close();
});
