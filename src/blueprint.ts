import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import type { ApprovalPolicy } from "./approval";
import { zingHome } from "./env";
import type { PluginRegistry } from "./plugin/registry";
import { SKILL_TOOL_NAME } from "./skills";

const BLUEPRINT_NAMES = ["agent.yaml", "agent.yml", "blueprint.yaml", "blueprint.yml"] as const;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOOLS_ERROR = "tools must be a list of exact tool names, for example [market__quote]";
const APPROVAL_ERROR = 'approval must be "writes" or a list of tool names from tools';
const SKILLS_ERROR = "skills must be a list of skill directory paths, for example [./skills/weekly-report]";

export type AgentLimits = { turnTimeoutMs: number; maxModelTurns: number; maxToolCalls: number };

/** The kind: a versioned birth spec. Copying this is not copying a capsule. */
export type Blueprint = {
  name: string;
  description?: string;
  model?: string;
  system?: string;
  source?: string;
  limits?: Partial<AgentLimits>;
  /** Exact names of tools exposed to the model. */
  tools: string[];
  /** Which of those tools ask the user before each call. */
  approval?: ApprovalPolicy;
  /** Absolute paths of the skill directories the model may load, in order. */
  skills?: string[];
};

export type FindBlueprintOptions = { cwd?: string; home?: string; explicit?: string; env?: NodeJS.ProcessEnv };

/** Skill paths resolve against baseDir, normally the blueprint file's directory. */
export function parseBlueprint(raw: unknown, source = "<blueprint>", baseDir = process.cwd()): Blueprint {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source}: blueprint must be a mapping`);
  const record = raw as Record<string, unknown>;
  const tools = parseTools(record.tools, source);
  const approval = parseApproval(record.approval, tools, source);
  return {
    name: requiredString(record.name, `${source}: name`),
    description: optionalString(record.description, `${source}: description`),
    model: optionalString(record.model, `${source}: model`),
    system: optionalString(record.system, `${source}: system`),
    source,
    limits: parseLimits(record.limits, source),
    tools,
    ...(approval === undefined ? {} : { approval }),
    skills: parseSkills(record.skills, source, baseDir),
  };
}

export async function loadBlueprint(path: string, cwd = process.cwd()): Promise<Blueprint> {
  const resolved = resolve(cwd, path);
  let contents: string;
  try {
    contents = await readFile(resolved, "utf8");
  } catch (error) {
    throw new Error(`Blueprint not found: ${resolved}`, { cause: error });
  }
  return parseBlueprint(parseYaml(contents), resolved, dirname(resolved));
}

export async function findBlueprint(options: FindBlueprintOptions = {}): Promise<string | undefined> {
  const cwd = options.cwd ?? process.cwd(); const env = options.env ?? process.env;
  const explicit = options.explicit?.trim() || env.ZING_BLUEPRINT?.trim() || env.ZING_AGENT?.trim();
  if (explicit) return resolve(cwd, explicit);
  for (const dir of [cwd, options.home ?? zingHome(env)]) for (const name of BLUEPRINT_NAMES) {
    const candidate = join(dir, name); if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

export function defaultBlueprint(options: { model?: string } = {}): Blueprint {
  return { name: "zing", model: options.model, tools: [] };
}

/** A station-level MODEL override replaces the Blueprint's model id. */
export function withModelOverride(blueprint: Blueprint, override?: string): Blueprint {
  return override === undefined ? blueprint : { ...blueprint, model: override };
}

export function resolveBlueprintTools(blueprint: Blueprint, registry: PluginRegistry) {
  const tools = blueprint.tools.map((name) => registry.getTool(name));
  const missing = blueprint.tools.filter((_, index) => !tools[index]);
  if (missing.length) {
    const registered = registry.listTools().map((tool) => tool.name);
    throw new Error(`Tools are not registered: ${missing.join(", ")}. Registered: ${registered.join(", ") || "none"}`);
  }
  return tools.filter((tool) => tool !== undefined);
}

function parseTools(raw: unknown, source: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${source}: ${TOOLS_ERROR}`);
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") throw new Error(`${source}: ${TOOLS_ERROR}`);
    const name = value.trim();
    if (!TOOL_NAME.test(name)) throw new Error(`${source}: invalid tool name "${value}"`);
    if (name === SKILL_TOOL_NAME) throw new Error(`${source}: tool "${name}" is reserved; Zing provides it when skills are listed`);
    if (names.includes(name)) throw new Error(`${source}: duplicate tool name "${name}"`);
    names.push(name);
  }
  return names;
}

function parseApproval(raw: unknown, tools: readonly string[], source: string): ApprovalPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === "writes") return raw;
  if (!Array.isArray(raw)) throw new Error(`${source}: ${APPROVAL_ERROR}`);
  const names: string[] = [];
  for (const value of raw) {
    const name = typeof value === "string" ? value.trim() : "";
    if (!tools.includes(name)) throw new Error(`${source}: approval lists "${String(value)}", which is not in tools`);
    if (names.includes(name)) throw new Error(`${source}: duplicate approval tool "${name}"`);
    names.push(name);
  }
  return names;
}

function parseSkills(raw: unknown, source: string, baseDir: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${source}: ${SKILLS_ERROR}`);
  const paths: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") throw new Error(`${source}: ${SKILLS_ERROR}`);
    const path = value.trim();
    // A bare name is reserved for skills that plugins may provide later.
    if (!/^(\.{1,2})?\//.test(path)) throw new Error(`${source}: skill "${value}" must be a path starting with ./, ../, or /`);
    const resolved = resolve(baseDir, path);
    if (paths.includes(resolved)) throw new Error(`${source}: duplicate skill path "${path}"`);
    paths.push(resolved);
  }
  return paths;
}

function parseLimits(raw: unknown, source: string): Partial<AgentLimits> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source}: limits must be a mapping`);
  const record = raw as Record<string, unknown>; const known = new Set<keyof AgentLimits>(["turnTimeoutMs", "maxModelTurns", "maxToolCalls"]);
  for (const key of Object.keys(record)) if (!known.has(key as keyof AgentLimits)) throw new Error(`${source}: unknown limit ${key}`);
  const limits: Partial<AgentLimits> = {};
  for (const key of known) { const value = optionalPositiveInteger(record[key], `${source}: limits.${key}`); if (value !== undefined) limits[key] = value; }
  return limits;
}

function optionalPositiveInteger(value: unknown, source: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${source} must be a positive integer`);
  return value;
}
function requiredString(value: unknown, source: string): string { const text = optionalString(value, source); if (!text) throw new Error(`${source} is required`); return text; }
function optionalString(value: unknown, source: string): string | undefined { if (value === undefined || value === null) return undefined; if (typeof value !== "string") throw new Error(`${source} must be a string`); return value.trim() || undefined; }
async function isFile(path: string): Promise<boolean> { try { return (await stat(path)).isFile(); } catch { return false; } }
