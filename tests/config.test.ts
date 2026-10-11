import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config";
import { zingHome } from "../src/env";

test("zingHome belongs to environment configuration", () => {
  assert.equal(zingHome({ ZING_HOME: " /srv/zing " }), "/srv/zing");
  assert.equal(zingHome({}), join(homedir(), ".zing"));
});

test("loadConfig reads environment fields and plugin paths", () => {
  const config = loadConfig({
    MODEL: "grok-4.6",
    CHANNEL: "telegram",
    PROVIDER: "xai",
    ZING_CAPSULE: "./.zing/capsule",
    ZING_PLUGINS: "./plugins/channels/telegram, ~/.zing/extra",
  });

  assert.equal(config.model, "grok-4.6");
  assert.equal(config.channel, "telegram");
  assert.equal(config.provider, "xai");
  assert.equal(config.capsulePath, "./.zing/capsule");
  assert.deepEqual(config.pluginPaths, ["./plugins/channels/telegram", "~/.zing/extra"]);
});

test("station config is the base and environment and CLI values override or append", () => {
  const config = loadConfig(
    { CHANNEL: "slack", PROVIDER: "anthropic", ZING_PLUGINS: "./env-plugin" },
    {
      station: { channel: "telegram", provider: "xai", plugins: ["/station/plugin"] },
      channel: "stdio",
      pluginPaths: ["./cli-plugin"],
    },
  );

  assert.equal(config.channel, "stdio");
  assert.equal(config.provider, "anthropic");
  assert.deepEqual(config.pluginPaths, ["/station/plugin", "./env-plugin", "./cli-plugin"]);
});

test("loadConfig does not require a channel, provider, or secrets", () => {
  const config = loadConfig({});
  assert.equal(config.model, undefined);
  assert.equal(config.channel, undefined);
  assert.equal(config.provider, undefined);
  assert.equal(config.capsulePath, undefined);
  assert.deepEqual(config.pluginPaths, []);
});

test("loadConfig accepts CLI overrides", () => {
  const config = loadConfig(
    {
      CHANNEL: "telegram",
      PROVIDER: "xai",
      ZING_CAPSULE: "./env-capsule",
      ZING_PLUGINS: "./env-plugin",
    },
    { channel: "stdio", provider: "anthropic", capsulePath: "./cli-capsule", pluginPaths: ["./cli-plugin"] },
  );
  assert.equal(config.channel, "stdio");
  assert.equal(config.provider, "anthropic");
  assert.equal(config.capsulePath, "./cli-capsule");
  assert.deepEqual(config.pluginPaths, ["./env-plugin", "./cli-plugin"]);
});
