import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import { parse as parseYaml } from "yaml";

import { findBundleManifest, loadBundle, type Bundle } from "./bundle";
import type { Tool } from "./plugin/types";

const SKILL_FILE = "SKILL.md";
/** The one tool that loads skills. Reserved: plugins cannot register it and blueprints do not list it. */
export const SKILL_TOOL_NAME = "skill";
/** The system prompt section that lists the skills. */
export const SKILLS_SECTION = "skills";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1_024;
/** One tool result holds at most this many lines or characters; the rest is paged with `offset`. */
const MAX_RESULT_LINES = 2_000;
const MAX_RESULT_CHARS = 50_000;
const MAX_FILE_BYTES = 1024 * 1024;

/** Instructions for one kind of task, in the Agent Skills format: a directory with a SKILL.md. */
export type Skill = {
  /** A bundle's skills are named <bundle>:<skill>, so two bundles cannot collide. */
  name: string;
  /** When to use the skill. The model sees it in every request. */
  description: string;
  /** The real path of the skill's directory; the skill tool reads files only inside it. */
  dir: string;
  /** SKILL.md after its frontmatter, as read at startup. */
  instructions: string;
};

/**
 * Read the paths a blueprint lists, in order: a skill directory, or a bundle root for all of its skills.
 * Any invalid skill fails the whole set.
 */
export async function loadSkills(paths: readonly string[]): Promise<Skill[]> {
  const skills: Skill[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    for (const skill of await loadSkillPath(path)) {
      const previous = seen.get(skill.name);
      if (previous !== undefined) {
        throw new Error(`Duplicate skill name ${skill.name}: ${previous} and ${path}`);
      }
      seen.set(skill.name, path);
      skills.push(skill);
    }
  }
  return skills;
}

async function loadSkillPath(path: string): Promise<Skill[]> {
  if (!(await isFile(join(path, SKILL_FILE))) && (await findBundleManifest(path))) {
    const bundle = await loadBundle(path);
    const dirs = bundle.skillsDir ? await skillDirectories(bundle.skillsDir) : [];
    if (dirs.length === 0) {
      throw new Error(`Bundle ${bundle.name} has no skills: ${path}`);
    }
    const skills: Skill[] = [];
    const withScripts: string[] = [];
    for (const dir of dirs) skills.push(await loadSkill(dir, bundle, withScripts));
    if (withScripts.length > 0) {
      console.warn(
        `Bundle ${bundle.name}: ${withScripts.length} skills have scripts/, which Zing does not run (${withScripts.join(", ")}).`,
      );
    }
    return skills;
  }
  return [await loadSkill(path, await enclosingBundle(path))];
}

/**
 * The subdirectories of a bundle's skills directory that hold a SKILL.md, by name. A SKILL.md deeper down belongs
 * to its skill, and a link does not count, so a bundle's skills stay inside it.
 */
async function skillDirectories(skillsDir: string): Promise<string[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const dir = join(skillsDir, entry.name);
    if (entry.isDirectory() && (await isFile(join(dir, SKILL_FILE)))) dirs.push(dir);
  }
  return dirs;
}

/**
 * The bundle whose skills directory holds this skill directory, if any. A Codex manifest may put that directory at
 * any depth, so the nearest manifest above the skill decides; one whose skills live elsewhere leaves it standalone.
 */
async function enclosingBundle(path: string): Promise<Bundle | undefined> {
  const parent = await realpath(dirname(resolve(path))).catch(() => undefined);
  if (!parent) return undefined;
  for (let dir = parent; ; dir = dirname(dir)) {
    if (await findBundleManifest(dir)) {
      const bundle = await loadBundle(dir).catch(() => undefined);
      return bundle && parent === bundle.skillsDir ? bundle : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/**
 * A skill from a bundle is named <bundle>:<name>. Its name need not match its directory: ChatGPT and Codex take
 * the name from the frontmatter, and their published plugins rely on that. withScripts collects the names of skills
 * with scripts/ for the caller to report together, instead of a warning for each.
 */
async function loadSkill(path: string, bundle?: Bundle, withScripts?: string[]): Promise<Skill> {
  const file = join(path, SKILL_FILE);
  let contents: string;
  let dir: string;
  try {
    contents = await readFile(file, "utf8");
    dir = await realpath(path);
  } catch (error) {
    throw new Error(`Skill not found: ${file}`, { cause: error });
  }
  const { frontmatter, body } = splitFrontmatter(contents, file);
  const local = parseName(frontmatter.name, bundle ? undefined : basename(path), file);
  const name = bundle ? `${bundle.name}:${local}` : local;
  const description = parseDescription(frontmatter.description, file);
  const instructions = body.trim();
  if (!instructions) {
    throw new Error(`${file}: instructions after the frontmatter are empty`);
  }
  if (await isDirectory(join(dir, "scripts"))) {
    if (withScripts) withScripts.push(name);
    else console.warn(`Skill ${name} has scripts/, which Zing does not run. Give the agent a plugin tool for that work.`);
  }
  return { name, description, dir, instructions };
}

/** The skills section's text, or undefined without skills. */
export function renderSkillCatalog(skills: readonly Skill[]): string | undefined {
  if (skills.length === 0) return undefined;
  return [
    `Skills are instructions for specific tasks. When a request matches a skill's description, call the ${SKILL_TOOL_NAME} tool with its name and follow what it returns. A skill cannot give you tools you do not have.`,
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}

/** A section as pi-durable renders a tagged one, so both runtimes send the same prompt. */
export function tagSection(key: string, text: string): string {
  return `<${key}>\n${text}\n</${key}>`;
}

/** The full system prompt: the blueprint's instructions, then the skills section. */
export function composeSystemPrompt(system: string, skills: readonly Skill[]): string {
  const catalog = renderSkillCatalog(skills);
  return catalog === undefined ? system : `${system}\n\n${tagSection(SKILLS_SECTION, catalog)}`;
}

/** Loads a skill's instructions, or a file inside its directory. It reads; it never executes. */
export function createSkillTool(skills: readonly Skill[]): Tool {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  return {
    name: SKILL_TOOL_NAME,
    description:
      "Load a skill's instructions by name. With path, load a text file the skill refers to, relative to the skill's directory. Files are returned as text and cannot be executed.",
    parameters: Type.Object({
      name: Type.String({ description: "A skill name from the skills list." }),
      path: Type.Optional(
        Type.String({ description: "A file in the skill's directory, such as references/format.md. Omit to load the instructions." }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 1, description: "First line to return, to continue a result that was cut off." }),
      ),
    }),
    async execute(input, { signal }) {
      signal.throwIfAborted();
      const name = String(input.name).trim();
      const skill = byName.get(name);
      if (!skill) {
        throw new Error(`Unknown skill: ${name}. Available: ${[...byName.keys()].join(", ")}`);
      }
      const path = typeof input.path === "string" ? input.path.trim() : undefined;
      const text = path ? await readSkillFile(skill, path) : skill.instructions;
      signal.throwIfAborted();
      const page = pageLines(text, typeof input.offset === "number" ? input.offset : 1);
      return {
        text: page.text,
        details: {
          skill: skill.name,
          ...(path ? { path } : {}),
          fromLine: page.from,
          toLine: page.to,
          totalLines: page.total,
        },
      };
    },
  };
}

/** The tools a runtime offers: the plugins' tools, then the skill tool when there are skills. */
export function withSkillTool(tools: readonly Tool[], skills: readonly Skill[]): Tool[] {
  if (skills.length === 0) return [...tools];
  if (tools.some((tool) => tool.name === SKILL_TOOL_NAME)) {
    throw new Error(`Tool name ${SKILL_TOOL_NAME} is reserved for skills`);
  }
  return [...tools, createSkillTool(skills)];
}

async function readSkillFile(skill: Skill, path: string): Promise<string> {
  if (isAbsolute(path)) {
    throw new Error(`path must be relative to the directory of skill ${skill.name}`);
  }
  let real: string;
  try {
    real = await realpath(resolve(skill.dir, path));
  } catch (error) {
    if (isEnoent(error)) throw new Error(`Skill ${skill.name} has no file ${path}`);
    throw error;
  }
  // realpath follows links, so a link inside the skill cannot reach a file outside it.
  if (real !== skill.dir && !real.startsWith(`${skill.dir}${sep}`)) {
    throw new Error(`${path} is outside the directory of skill ${skill.name}`);
  }
  const info = await stat(real);
  if (!info.isFile()) {
    throw new Error(`${path} in skill ${skill.name} is not a file`);
  }
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`${path} in skill ${skill.name} is larger than ${MAX_FILE_BYTES} bytes`);
  }
  const text = await readFile(real, "utf8");
  if (text.includes("\u0000")) {
    throw new Error(`${path} in skill ${skill.name} is not a text file`);
  }
  return text;
}

function pageLines(text: string, offset: number): { text: string; from: number; to: number; total: number } {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
  const total = lines.length;
  if (!Number.isSafeInteger(offset) || offset < 1 || offset > total) {
    throw new Error(`offset must be between 1 and ${total}`);
  }
  const shown: string[] = [];
  let chars = 0;
  let cut = false;
  let next = offset - 1;
  while (next < total && shown.length < MAX_RESULT_LINES) {
    const line = lines[next] ?? "";
    if (chars + line.length + 1 > MAX_RESULT_CHARS) {
      if (shown.length === 0) {
        shown.push(line.slice(0, MAX_RESULT_CHARS));
        cut = true;
        next += 1;
      }
      break;
    }
    shown.push(line);
    chars += line.length + 1;
    next += 1;
  }
  const notes: string[] = [];
  if (cut) notes.push(`[Line ${offset} is longer than ${MAX_RESULT_CHARS} characters and was cut off.]`);
  if (next < total) {
    notes.push(`[Showing lines ${offset}-${next} of ${total}. Call ${SKILL_TOOL_NAME} again with offset=${next + 1} to continue.]`);
  }
  const body = shown.join("\n");
  return { text: notes.length === 0 ? body : `${body}\n\n${notes.join("\n")}`, from: offset, to: next, total };
}

function splitFrontmatter(contents: string, file: string): { frontmatter: Record<string, unknown>; body: string } {
  const lines = contents.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const end = lines[0]?.trim() === "---" ? lines.findIndex((line, index) => index > 0 && line.trim() === "---") : -1;
  if (end < 0) {
    throw new Error(`${file}: must start with YAML frontmatter between --- lines`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(lines.slice(1, end).join("\n"));
  } catch (error) {
    throw new Error(`${file}: invalid frontmatter`, { cause: error });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file}: frontmatter must be a mapping`);
  }
  return { frontmatter: raw as Record<string, unknown>, body: lines.slice(end + 1).join("\n") };
}

function parseName(value: unknown, directory: string | undefined, file: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${file}: name is required`);
  }
  const name = value.trim();
  if (name.length > MAX_NAME_LENGTH || !SKILL_NAME.test(name)) {
    throw new Error(
      `${file}: invalid name "${name}". Use up to ${MAX_NAME_LENGTH} lowercase letters, digits, and single hyphens.`,
    );
  }
  if (directory !== undefined && name !== directory) {
    throw new Error(`${file}: name "${name}" must match its directory "${directory}"`);
  }
  return name;
}

function parseDescription(value: unknown, file: string): string {
  // The catalog lists one skill per line; YAML block scalars may span several.
  const description = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!description) {
    throw new Error(`${file}: description is required`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`${file}: description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return description;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
