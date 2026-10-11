import assert from "node:assert/strict";
import test from "node:test";

import { parseCli } from "../src/cli";

test("parseCli reads repeatable plugins, channel, and --once rest", () => {
  const cli = parseCli([
    "-e",
    "./a.ts",
    "--plugin",
    "./b",
    "--channel",
    "telegram",
    "--agent",
    "./agent.yaml",
    "--capsule",
    "./.zing/capsule",
    "--station",
    "./station.yaml",
    "--provider",
    "xai",
    "--once",
    "hello",
    "world",
  ]);
  assert.deepEqual(cli.pluginPaths, ["./a.ts", "./b"]);
  assert.equal(cli.channel, "telegram");
  assert.equal(cli.blueprint, "./agent.yaml");
  assert.equal(cli.capsule, "./.zing/capsule");
  assert.equal(cli.station, "./station.yaml");
  assert.equal(cli.provider, "xai");
  assert.equal(cli.onceMessage, "hello world");
  assert.equal(cli.help, false);
  assert.equal(cli.mode, "channel");
});

test("parseCli accepts equals forms and help", () => {
  const cli = parseCli([
    "--plugin=./a.ts",
    "--channel=discord",
    "--blueprint=./alice.yaml",
    "--capsule=/tmp/alice",
    "--station=./personal-station.yaml",
    "--provider=xai",
    "-h",
  ]);
  assert.deepEqual(cli.pluginPaths, ["./a.ts"]);
  assert.equal(cli.channel, "discord");
  assert.equal(cli.blueprint, "./alice.yaml");
  assert.equal(cli.capsule, "/tmp/alice");
  assert.equal(cli.station, "./personal-station.yaml");
  assert.equal(cli.provider, "xai");
  assert.equal(cli.help, true);
});

test("parseCli accepts app-server before or after options", () => {
  assert.equal(parseCli(["app-server", "--provider", "xai"]).mode, "app-server");
  assert.equal(parseCli(["--plugin", "./provider.ts", "app-server"]).mode, "app-server");
  assert.throws(() => parseCli(["app-server", "--once", "hello"]), /cannot be combined/);
  assert.throws(() => parseCli(["--channel", "telegram", "app-server"]), /cannot be combined/);
});

test("parseCli rejects unknown flags and missing values", () => {
  assert.throws(() => parseCli(["--nope"]), /Unknown argument/);
  assert.throws(() => parseCli(["--plugin"]), /requires a path/);
  assert.throws(() => parseCli(["--channel"]), /requires an id/);
  assert.throws(() => parseCli(["--agent"]), /requires a path/);
  assert.throws(() => parseCli(["--capsule"]), /requires a path/);
  assert.throws(() => parseCli(["--station"]), /requires a path/);
  assert.throws(() => parseCli(["--provider"]), /requires an id/);
  assert.throws(() => parseCli(["--plugin="]), /requires a path/);
  assert.throws(() => parseCli(["--station="]), /requires a path/);
});
