import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadBundle, loadBundles } from "../src/bundle";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

test("a portable bundle uses fixed locations; a Codex bundle uses its manifest or the conventional files", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zing-bundle-")));

  const portable = join(root, "portable");
  await writeJson(join(portable, "plugin.json"), { name: "docs-helper", version: "1.0.0", description: "Docs" });
  await writeJson(join(portable, "mcp.json"), { mcpServers: {} });
  // The Codex overlay only matters for OpenAI presentation settings; components stay at the root.
  await writeJson(join(portable, ".codex-plugin", "plugin.json"), { name: "other", mcpServers: "./elsewhere.json" });
  await mkdir(join(portable, "skills"));
  assert.deepEqual(await loadBundle(portable), {
    name: "docs-helper",
    version: "1.0.0",
    description: "Docs",
    dir: portable,
    skillsDir: join(portable, "skills"),
    mcpConfig: join(portable, "mcp.json"),
  });

  const codex = join(root, "codex");
  await writeJson(join(codex, ".codex-plugin", "plugin.json"), { name: "notion", skills: "./src/skills/" });
  await mkdir(join(codex, "src", "skills"), { recursive: true });
  await writeJson(join(codex, ".mcp.json"), { mcpServers: {} });
  assert.deepEqual(await loadBundle(codex), {
    name: "notion",
    version: undefined,
    description: undefined,
    dir: codex,
    skillsDir: join(codex, "src", "skills"),
    mcpConfig: join(codex, ".mcp.json"),
  });

  const bare = join(root, "bare");
  await writeJson(join(bare, ".codex-plugin", "plugin.json"), { name: "bare" });
  const loaded = await loadBundle(bare);
  assert.equal(loaded.skillsDir, undefined);
  assert.equal(loaded.mcpConfig, undefined);
});

test("bundle manifests are validated and cannot point outside the bundle", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zing-bundle-invalid-")));
  await writeFile(join(root, "outside.json"), "{}");
  const cases: Array<[string, unknown, RegExp]> = [
    ["dotdot", { name: "dotdot", mcpServers: "./x/../../outside.json" }, /must start with \.\/ and stay inside/],
    ["absolute", { name: "absolute", mcpServers: join(root, "outside.json") }, /must start with \.\/ and stay inside/],
    ["missing", { name: "missing", skills: "./skills" }, /\.\/skills does not exist/],
    ["Bad_Name", { name: "Bad_Name" }, /invalid name "Bad_Name"/],
    ["no-name", {}, /name is required/],
  ];
  for (const [dir, manifest, message] of cases) {
    await writeJson(join(root, dir, ".codex-plugin", "plugin.json"), manifest);
    await assert.rejects(loadBundle(join(root, dir)), message, dir);
  }

  const linked = join(root, "linked");
  await writeJson(join(linked, ".codex-plugin", "plugin.json"), { name: "linked", mcpServers: "./servers.json" });
  await symlink(join(root, "outside.json"), join(linked, "servers.json"));
  await assert.rejects(loadBundle(linked), /is outside the bundle/);

  await mkdir(join(root, "plain"));
  await assert.rejects(loadBundle(join(root, "plain")), /has no plugin\.json or \.codex-plugin/);

  await writeJson(join(root, "one", "plugin.json"), { name: "same" });
  await writeJson(join(root, "two", "plugin.json"), { name: "same" });
  await assert.rejects(loadBundles([join(root, "one"), join(root, "two")]), /Duplicate bundle name same/);
});
