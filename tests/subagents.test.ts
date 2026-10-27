import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadSubagents } from "../src/subagents";

async function writeAgent(root: string, file: string, contents: string): Promise<string> {
  const path = join(root, file);
  await writeFile(path, contents);
  return path;
}

test("loadSubagents reads blueprint fields from the frontmatter and the instructions from the body", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-subagents-"));
  await mkdir(join(root, "skills", "citations"), { recursive: true });
  await writeFile(join(root, "skills", "citations", "SKILL.md"), "---\nname: citations\ndescription: Cite sources.\n---\nLink every claim.\n");
  const researcher = await writeAgent(
    root,
    "researcher.md",
    [
      "---",
      "name: researcher",
      "description: >",
      "  Answer questions that need",
      "  several searches.",
      "model: fast-model",
      "tools: [web_search]",
      "skills: [./skills/citations]",
      "limits: { maxToolCalls: 4 }",
      "color: blue",
      "---",
      "Search, then answer with sources.",
      "",
    ].join("\n"),
  );
  const reviewer = await writeAgent(root, "reviewer.md", "---\nname: reviewer\ndescription: Review a draft.\nmodel: inherit\n---\nBe strict.\n");

  const [first, second, ...rest] = await loadSubagents([researcher, reviewer], ["web_search", "memory_search"]);
  assert.equal(rest.length, 0);
  assert.deepEqual(first?.blueprint, {
    name: "researcher",
    description: "Answer questions that need several searches.",
    model: "fast-model",
    system: "Search, then answer with sources.",
    source: researcher,
    limits: { maxToolCalls: 4 },
    tools: ["web_search"],
    skills: [join(root, "skills", "citations")],
    agents: [],
  });
  assert.deepEqual(first?.skills.map((skill) => skill.name), ["citations"]);
  // No tools means none, not the main agent's; "inherit" means the main agent's model.
  assert.deepEqual(second?.blueprint.tools, []);
  assert.equal(second?.blueprint.model, undefined);
});

test("an invalid subagent fails loading with its file", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-subagents-invalid-"));
  const cases: Array<[file: string, contents: string, error: RegExp]> = [
    ["wide.md", "---\nname: wide\ndescription: d\ntools: [web_search, shell]\n---\nGo.\n", /tools shell are not in the main agent's tools/],
    ["nested.md", "---\nname: nested\ndescription: d\nagents: [./other.md]\n---\nGo.\n", /a subagent cannot list agents/],
    ["delegate.md", "---\nname: delegate\ndescription: d\ntools: [subagent]\n---\nGo.\n", /tool "subagent" is reserved/],
    ["prompt.md", "---\nname: prompt\ndescription: d\nsystem: Go.\n---\nGo.\n", /write the instructions after the frontmatter/],
    ["renamed.md", "---\nname: other\ndescription: d\n---\nGo.\n", /name "other" must match its file name "renamed"/],
    ["Upper.md", "---\nname: Upper\ndescription: d\n---\nGo.\n", /invalid name "Upper"/],
    ["silent.md", "---\nname: silent\n---\nGo.\n", /silent\.md: description is required/],
    ["empty.md", "---\nname: empty\ndescription: d\n---\n\n", /empty\.md: instructions after the frontmatter are empty/],
    ["plain.md", "Just a prompt.\n", /plain\.md: must start with YAML frontmatter/],
  ];
  for (const [file, contents, error] of cases) {
    const path = await writeAgent(root, file, contents);
    await assert.rejects(loadSubagents([path], ["web_search"]), error, file);
  }
  await assert.rejects(loadSubagents([join(root, "missing.md")], []), /Subagent not found: .*missing\.md/);

  await mkdir(join(root, "a"));
  await mkdir(join(root, "b"));
  const one = await writeAgent(root, "a/twin.md", "---\nname: twin\ndescription: d\n---\nGo.\n");
  const two = await writeAgent(root, "b/twin.md", "---\nname: twin\ndescription: d\n---\nGo.\n");
  await assert.rejects(loadSubagents([one, two], []), /Duplicate subagent name twin/);
});
