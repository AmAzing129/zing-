import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { Type, type JsonValue } from "@earendil-works/pi-ai";

import { parseBlueprint, SUBAGENT_TOOL_NAME, type Blueprint } from "./blueprint";
import type { Tool, ToolContext } from "./plugin/types";
import { loadSkills, splitFrontmatter, type Skill } from "./skills";

export { SUBAGENT_TOOL_NAME } from "./blueprint";
/** The system prompt section that lists the subagents. */
export const SUBAGENTS_SECTION = "subagents";

const SUBAGENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1_024;
/** The model value other agent formats use for "the parent's model"; Zing treats it as an omitted model. */
const INHERIT_MODEL = "inherit";

/**
 * A blueprint the main agent delegates to, written as Markdown: blueprint fields as frontmatter, then the instructions.
 * It runs in the same station and capsule, only when the main agent calls the subagent tool.
 */
export type Subagent = {
  /** Its kind. Without a model it uses the main agent's; its tools are a subset of the main agent's. */
  blueprint: Blueprint & { description: string; system: string };
  /** The skills its blueprint lists, loaded. */
  skills: Skill[];
};

/** Runs one delegated task to its final answer, within the calling tool's turn. */
export type SubagentRun = (
  subagent: Subagent,
  task: string,
  context: ToolContext,
) => Promise<{ text: string; details?: JsonValue }>;

/**
 * Read the subagent files a blueprint lists, in order. A subagent may use only tools in `allowedTools`, the main
 * agent's exact allowlist, so delegating never grants a capability. Any invalid subagent fails the whole set.
 */
export async function loadSubagents(paths: readonly string[], allowedTools: readonly string[]): Promise<Subagent[]> {
  const subagents: Subagent[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const subagent = await loadSubagent(path, allowedTools);
    const name = subagent.blueprint.name;
    const previous = seen.get(name);
    if (previous !== undefined) {
      throw new Error(`Duplicate subagent name ${name}: ${previous} and ${path}`);
    }
    seen.set(name, path);
    subagents.push(subagent);
  }
  return subagents;
}

async function loadSubagent(file: string, allowedTools: readonly string[]): Promise<Subagent> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Subagent not found: ${file}`, { cause: error });
  }
  const { frontmatter, body } = splitFrontmatter(contents, file);
  if ("system" in frontmatter) {
    throw new Error(`${file}: write the instructions after the frontmatter, not in system`);
  }
  if ("agents" in frontmatter) {
    throw new Error(`${file}: a subagent cannot list agents`);
  }
  const parsed = parseBlueprint({ ...frontmatter, system: body }, file, dirname(file));
  const name = parsed.name;
  if (name.length > MAX_NAME_LENGTH || !SUBAGENT_NAME.test(name)) {
    throw new Error(
      `${file}: invalid name "${name}". Use up to ${MAX_NAME_LENGTH} lowercase letters, digits, and single hyphens.`,
    );
  }
  const expected = basename(file, ".md");
  if (name !== expected) {
    throw new Error(`${file}: name "${name}" must match its file name "${expected}"`);
  }
  // The catalog lists one subagent per line; YAML block scalars may span several.
  const description = parsed.description?.replace(/\s+/g, " ");
  if (!description) {
    throw new Error(`${file}: description is required`);
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    throw new Error(`${file}: description is longer than ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  if (!parsed.system) {
    throw new Error(`${file}: instructions after the frontmatter are empty`);
  }
  const extra = parsed.tools.filter((tool) => !allowedTools.includes(tool));
  if (extra.length > 0) {
    throw new Error(
      `${file}: tools ${extra.join(", ")} are not in the main agent's tools. A subagent can use only tools agent.yaml lists.`,
    );
  }
  const model = parsed.model === INHERIT_MODEL ? undefined : parsed.model;
  return {
    blueprint: { ...parsed, model, description, system: parsed.system },
    skills: await loadSkills(parsed.skills ?? []),
  };
}

/** The subagents section's text, or undefined without subagents. */
export function renderSubagentCatalog(subagents: readonly Subagent[]): string | undefined {
  if (subagents.length === 0) return undefined;
  return [
    `Subagents are specialists you can delegate a self-contained task to. When a task matches a subagent's description, call the ${SUBAGENT_TOOL_NAME} tool with its name and the task. A subagent does not see this conversation, so the task must say everything it needs. You get back only its final answer.`,
    ...subagents.map(({ blueprint }) => `- ${blueprint.name}: ${blueprint.description}`),
  ].join("\n");
}

/** Delegates a task to a subagent and returns its final answer. */
export function createSubagentTool(subagents: readonly Subagent[], run: SubagentRun): Tool {
  const byName = new Map(subagents.map((subagent) => [subagent.blueprint.name, subagent]));
  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      "Delegate a self-contained task to a subagent by name and return its final answer. The subagent starts without this conversation, so the task must include everything it needs.",
    parameters: Type.Object({
      name: Type.String({ description: "A subagent name from the subagents list." }),
      task: Type.String({ description: "The complete task: what to do, the context it needs, and what to return." }),
    }),
    async execute(input, context) {
      context.signal.throwIfAborted();
      const name = String(input.name).trim();
      const subagent = byName.get(name);
      if (!subagent) {
        throw new Error(`Unknown subagent: ${name}. Available: ${[...byName.keys()].join(", ")}`);
      }
      const task = String(input.task).trim();
      if (!task) {
        throw new Error("task is empty");
      }
      return run(subagent, task, context);
    },
  };
}

/** The tools a runtime offers: the given tools, then the subagent tool when there are subagents. */
export function withSubagentTool(tools: readonly Tool[], subagents: readonly Subagent[], run: SubagentRun): Tool[] {
  if (subagents.length === 0) return [...tools];
  if (tools.some((tool) => tool.name === SUBAGENT_TOOL_NAME)) {
    throw new Error(`Tool name ${SUBAGENT_TOOL_NAME} is reserved for subagents`);
  }
  return [...tools, createSubagentTool(subagents, run)];
}
