import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { zingHome } from "./env";
import type { PluginRegistry } from "./plugin/registry";

const BLUEPRINT_NAMES = ["agent.yaml", "agent.yml", "blueprint.yaml", "blueprint.yml"] as const;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOOLS_ERROR = "tools must be a list of exact tool names, for example [market__quote]";

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
};

export type FindBlueprintOptions = { cwd?: string; home?: string; explicit?: string; env?: NodeJS.ProcessEnv };

export function parseBlueprint(raw: unknown, source = "<blueprint>"): Blueprint {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source}: blueprint must be a mapping`);
  const record = raw as Record<string, unknown>;
  return {
    name: requiredString(record.name, `${source}: name`),
    description: optionalString(record.description, `${source}: description`),
    model: optionalString(record.model, `${source}: model`),
    system: optionalString(record.system, `${source}: system`),
    source,
    limits: parseLimits(record.limits, source),
    tools: parseTools(record.tools, source),
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
  return parseBlueprint(parseYaml(contents), resolved);
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

export function withBlueprintModel(blueprint: Blueprint, fallback?: string): Blueprint {
  return blueprint.model !== undefined || fallback === undefined ? blueprint : { ...blueprint, model: fallback };
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
    if (names.includes(name)) throw new Error(`${source}: duplicate tool name "${name}"`);
    names.push(name);
  }
  return names;
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
