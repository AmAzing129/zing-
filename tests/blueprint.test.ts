import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { defaultBlueprint, findBlueprint, loadBlueprint, parseBlueprint, resolveBlueprintTools, withModelOverride } from "../src/blueprint";
import { createPluginRegistry } from "../src/plugin/index";

const fixtures = fileURLToPath(new URL("./fixtures/agents", import.meta.url));

test("parseBlueprint reads identity, model, system, and tools", () => {
  assert.deepEqual(parseBlueprint({ name: "alice", description: "A researcher", model: "grok", system: "Brief.", tools: ["web_search"] }, "memory"), {
    name: "alice", description: "A researcher", model: "grok", system: "Brief.", source: "memory", limits: undefined, tools: ["web_search"], skills: [],
  });
});

test("tools default to an empty list", () => {
  assert.deepEqual(parseBlueprint({ name: "empty" }).tools, []);
  assert.deepEqual(parseBlueprint({ name: "empty", tools: [] }).tools, []);
});

test("MCP tool names are accepted", () => {
  assert.deepEqual(parseBlueprint({ name: "mcp", tools: ["market__quote"] }).tools, ["market__quote"]);
});

test("tools must be a unique list of exact valid strings", () => {
  const message = /tools must be a list of exact tool names, for example \[market__quote\]/;
  assert.throws(() => parseBlueprint({ name: "a", tools: "web_search" }), message);
  assert.throws(() => parseBlueprint({ name: "a", tools: ["web_search", 1] }), message);
  assert.throws(() => parseBlueprint({ name: "a", tools: ["web_search", "web_search"] }), /duplicate/);
  assert.throws(() => parseBlueprint({ name: "a", tools: ["market__*"] }), /invalid tool name/);
  assert.throws(() => parseBlueprint({ name: "a", tools: { ["web" + ".search@1"]: "brave" } }), message);
  assert.throws(() => parseBlueprint({ name: "a", tools: { allow: ["web_search"] } }), message);
});

test("skills are local paths resolved from the blueprint file's directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-blueprint-skills-"));
  const path = join(root, "agents", "agent.yaml");
  await mkdir(join(root, "agents"));
  await writeFile(path, "name: skilled\nskills:\n  - ./skills/weekly-report\n  - ../shared/trip-planner\n  - /opt/skills/tax\n");
  assert.deepEqual((await loadBlueprint(path, "/elsewhere")).skills, [
    join(root, "agents", "skills", "weekly-report"),
    join(root, "shared", "trip-planner"),
    "/opt/skills/tax",
  ]);
  assert.deepEqual(parseBlueprint({ name: "plain" }).skills, []);
  assert.throws(() => parseBlueprint({ name: "a", skills: "./skills/x" }), /skills must be a list of skill directory paths/);
  assert.throws(() => parseBlueprint({ name: "a", skills: ["weekly-report"] }), /must be a path starting with \.\/, \.\.\/, or \//);
  assert.throws(() => parseBlueprint({ name: "a", skills: ["./skills/x", "skills/../skills/x/"] }), /must be a path/);
  assert.throws(() => parseBlueprint({ name: "a", skills: ["./skills/x", "./skills/../skills/x/"] }, "agent.yaml", "/base"), /duplicate skill path/);
});

test("the skill tool is reserved and cannot be listed", () => {
  assert.throws(() => parseBlueprint({ name: "a", tools: ["skill"] }), /tool "skill" is reserved/);
});

test("name is required", () => assert.throws(() => parseBlueprint({ tools: [] }, "x.yaml"), /name is required/));

test("limits retain their validation", () => {
  assert.deepEqual(parseBlueprint({ name: "bounded", limits: { turnTimeoutMs: 60000, maxModelTurns: 8, maxToolCalls: 12 } }).limits, { turnTimeoutMs: 60000, maxModelTurns: 8, maxToolCalls: 12 });
  assert.throws(() => parseBlueprint({ name: "a", limits: { maxModelTurns: 0 } }), /positive integer/);
  assert.throws(() => parseBlueprint({ name: "a", limits: { maxTokens: 1 } }), /unknown limit maxTokens/);
  assert.throws(() => parseBlueprint({ name: "a", limits: [] }), /limits must be a mapping/);
});

test("loadBlueprint reads a yaml fixture", async () => {
  const blueprint = await loadBlueprint(join(fixtures, "ok.yaml"));
  assert.equal(blueprint.name, "researcher");
  assert.deepEqual(blueprint.tools, ["web_search"]);
  assert.match(blueprint.system ?? "", /Be brief/);
});

test("loadBlueprint wraps every read error with the resolved path and cause", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-blueprint-read-"));
  await assert.rejects(loadBlueprint(root), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, `Blueprint not found: ${root}`);
    assert.equal((error.cause as NodeJS.ErrnoException | undefined)?.code, "EISDIR");
    return true;
  });
});

test("loadBlueprint preserves validation errors from readable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-blueprint-parse-"));
  const path = join(root, "invalid.yaml");
  await writeFile(path, "tools: []\n");

  await assert.rejects(loadBlueprint(path), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /name is required/);
    assert.doesNotMatch(error.message, /Blueprint not found/);
    return true;
  });
});

test("findBlueprint prefers explicit, then cwd, then home", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-agent-"));
  const cwd = join(root, "project"); const home = join(root, "home");
  await mkdir(cwd, { recursive: true }); await mkdir(home, { recursive: true });
  await writeFile(join(cwd, "agent.yaml"), "name: cwd\ntools: []\n");
  await writeFile(join(home, "agent.yaml"), "name: home\ntools: []\n");
  await writeFile(join(root, "explicit.yaml"), "name: explicit\ntools: []\n");
  assert.equal(await findBlueprint({ cwd, home, explicit: join(root, "explicit.yaml") }), join(root, "explicit.yaml"));
  assert.equal(await findBlueprint({ cwd, home }), join(cwd, "agent.yaml"));
  assert.equal(await findBlueprint({ cwd: join(root, "empty"), home }), join(home, "agent.yaml"));
  assert.equal(await findBlueprint({ cwd: join(root, "empty"), home: join(root, "empty-home") }), undefined);
});

test("defaultBlueprint has no tools and withModelOverride replaces the model", () => {
  assert.deepEqual(defaultBlueprint().tools, []);
  assert.equal(withModelOverride(defaultBlueprint(), "env-model").model, "env-model");
  assert.equal(withModelOverride(defaultBlueprint({ model: "blueprint-model" }), "env-model").model, "env-model");
  const blueprint = defaultBlueprint({ model: "blueprint-model" });
  assert.strictEqual(withModelOverride(blueprint, undefined), blueprint);
});

test("resolveBlueprintTools exposes exact listed tools and reports missing names", () => {
  const registry = createPluginRegistry(); const parameters = {};
  for (const name of ["market__quote", "market__trade"]) registry.api.registerTool({ name, description: name, parameters, execute: async () => ({ text: "ok" }) });
  assert.deepEqual(resolveBlueprintTools(parseBlueprint({ name: "a", tools: ["market__quote"] }), registry).map((tool) => tool.name), ["market__quote"]);
  assert.throws(() => resolveBlueprintTools(parseBlueprint({ name: "a", tools: ["news__latest"] }), registry), /Tools are not registered: news__latest\. Registered: market__quote, market__trade/);
});

test("approval is writes or a list of the blueprint's own tools", () => {
  const tools = ["notion__search", "notion__create"];
  assert.equal(parseBlueprint({ name: "a", tools }).approval, undefined);
  assert.equal(parseBlueprint({ name: "a", tools, approval: "writes" }).approval, "writes");
  assert.deepEqual(parseBlueprint({ name: "a", tools, approval: ["notion__create"] }).approval, ["notion__create"]);
  assert.throws(() => parseBlueprint({ name: "a", tools, approval: ["slack__post"] }), /approval lists "slack__post", which is not in tools/);
  assert.throws(() => parseBlueprint({ name: "a", tools, approval: ["notion__create", "notion__create"] }), /duplicate approval/);
  assert.throws(() => parseBlueprint({ name: "a", tools, approval: "all" }), /approval must be "writes" or a list/);
});
