import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMemoryCapsule } from "../src/capsule";
import type { ToolContext } from "../src/plugin/index";
import { createSkillTool, loadSkills } from "../src/skills";

const context: ToolContext = {
  signal: new AbortController().signal,
  conversationId: "test",
  capsule: { agentId: "agt_test", state: createMemoryCapsule().state },
};

async function writeSkill(root: string, dir: string, contents: string): Promise<string> {
  const path = join(root, dir);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), contents);
  return path;
}

test("loadSkills reads name, description, and instructions in the listed order", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-skills-"));
  const report = await writeSkill(
    root,
    "weekly-report",
    "\uFEFF---\r\nname: weekly-report\r\ndescription: >\r\n  Write my weekly report.\r\n  Use when I ask for a summary of the week.\r\nlicense: MIT\r\nallowed-tools: Bash\r\n---\r\n\r\n# Weekly report\r\n\r\n1. Ask for highlights.\r\n",
  );
  const trip = await writeSkill(root, "trip", "---\nname: trip\ndescription: Plan trips.\n---\nPlan it.");

  const skills = await loadSkills([trip, report]);

  assert.deepEqual(skills, [
    { name: "trip", description: "Plan trips.", dir: await realpath(trip), instructions: "Plan it." },
    {
      name: "weekly-report",
      description: "Write my weekly report. Use when I ask for a summary of the week.",
      dir: await realpath(report),
      instructions: "# Weekly report\n\n1. Ask for highlights.",
    },
  ]);
});

test("an invalid skill fails loading with its file", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-skills-invalid-"));
  const cases: Array<[string, string | undefined, RegExp]> = [
    ["missing", undefined, /Skill not found: .*missing\/SKILL\.md/],
    ["no-frontmatter", "name: no-frontmatter\n", /must start with YAML frontmatter/],
    ["unclosed", "---\nname: unclosed\ndescription: d\n", /must start with YAML frontmatter/],
    ["mismatch", "---\nname: other\ndescription: d\n---\nbody", /name "other" must match its directory "mismatch"/],
    ["Bad_Name", "---\nname: Bad_Name\ndescription: d\n---\nbody", /invalid name "Bad_Name"/],
    ["double--hyphen", "---\nname: double--hyphen\ndescription: d\n---\nbody", /invalid name/],
    ["no-description", "---\nname: no-description\n---\nbody", /description is required/],
    ["long-description", `---\nname: long-description\ndescription: ${"x".repeat(1_025)}\n---\nbody`, /longer than 1024/],
    ["empty", "---\nname: empty\ndescription: d\n---\n\n", /instructions after the frontmatter are empty/],
    ["list", "---\n- a\n---\nbody", /frontmatter must be a mapping/],
  ];
  for (const [dir, contents, message] of cases) {
    const path = contents === undefined ? join(root, dir) : await writeSkill(root, dir, contents);
    await assert.rejects(loadSkills([path]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, message, dir);
      return true;
    });
  }
  const valid = "---\nname: same\ndescription: d\n---\nbody";
  const first = await writeSkill(join(root, "a"), "same", valid);
  const second = await writeSkill(join(root, "b"), "same", valid);
  await assert.rejects(loadSkills([first, second]), /Duplicate skill name same/);
  assert.equal((await loadSkills([first])).length, 1, "the duplicates are each valid alone");
});

test("the skill tool loads instructions and only files inside the skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-skill-tool-"));
  const dir = await writeSkill(root, "weekly-report", "---\nname: weekly-report\ndescription: d\n---\nFollow references/format.md.");
  await mkdir(join(dir, "references"));
  await writeFile(join(dir, "references", "format.md"), "## Format\n- Done\n");
  await mkdir(join(root, "weekly-report-private"));
  await writeFile(join(root, "weekly-report-private", "secret.md"), "secret");
  await writeFile(join(root, "outside.md"), "outside");
  await symlink(join(root, "outside.md"), join(dir, "references", "link.md"));
  const tool = createSkillTool(await loadSkills([dir]));
  const run = (input: Record<string, unknown>) => tool.execute(input, context);

  assert.deepEqual(await run({ name: "weekly-report" }), {
    text: "Follow references/format.md.",
    details: { skill: "weekly-report", fromLine: 1, toLine: 1, totalLines: 1 },
  });
  assert.equal((await run({ name: "weekly-report", path: "references/format.md" })).text, "## Format\n- Done");
  assert.equal((await run({ name: "weekly-report", path: "./references/../SKILL.md" })).text.split("\n")[0], "---");

  for (const [path, message] of [
    ["../outside.md", /outside the directory of skill weekly-report/],
    ["../weekly-report-private/secret.md", /outside the directory/],
    ["references/link.md", /outside the directory/],
    [join(dir, "SKILL.md"), /path must be relative/],
    ["references/missing.md", /Skill weekly-report has no file references\/missing\.md/],
    ["references", /references in skill weekly-report is not a file/],
  ] as const) {
    await assert.rejects(run({ name: "weekly-report", path }), message, path);
  }
  await assert.rejects(run({ name: "nope" }), /Unknown skill: nope\. Available: weekly-report/);
});

test("the skill tool pages long text by lines and characters", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-skill-page-"));
  const dir = await writeSkill(root, "big", "---\nname: big\ndescription: d\n---\nbody");
  const numbered = Array.from({ length: 2_500 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(dir, "many.md"), `${numbered.join("\n")}\n`);
  // 101 characters per line with its newline: 495 lines fit in 50,000 characters, 496 do not.
  await writeFile(join(dir, "wide.md"), Array.from({ length: 600 }, () => "w".repeat(100)).join("\n"));
  await writeFile(join(dir, "one-line.md"), "x".repeat(60_000));
  const tool = createSkillTool(await loadSkills([dir]));
  const run = (input: Record<string, unknown>) => tool.execute({ name: "big", ...input }, context);

  const first = await run({ path: "many.md" });
  const firstLines = first.text.split("\n");
  assert.equal(firstLines[0], "line 1");
  assert.equal(firstLines[1_999], "line 2000");
  assert.equal(firstLines.at(-1), "[Showing lines 1-2000 of 2500. Call skill again with offset=2001 to continue.]");
  assert.deepEqual(first.details, { skill: "big", path: "many.md", fromLine: 1, toLine: 2_000, totalLines: 2_500 });

  const rest = await run({ path: "many.md", offset: 2_001 });
  assert.equal(rest.text, numbered.slice(2_000).join("\n"));

  const wide = await run({ path: "wide.md" });
  assert.match(wide.text, /\[Showing lines 1-495 of 600\. Call skill again with offset=496 to continue\.\]$/);

  const long = await run({ path: "one-line.md" });
  assert.ok(long.text.startsWith(`${"x".repeat(50_000)}\n\n[Line 1 is longer than 50000 characters and was cut off.]`));
  assert.deepEqual(long.details, { skill: "big", path: "one-line.md", fromLine: 1, toLine: 1, totalLines: 1 });

  await assert.rejects(run({ path: "many.md", offset: 2_501 }), /offset must be between 1 and 2500/);
});
