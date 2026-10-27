import { renderSkillCatalog, SKILLS_SECTION, type Skill } from "./skills";
import { renderSubagentCatalog, SUBAGENTS_SECTION, type Subagent } from "./subagents";

/** The sections after the blueprint's instructions, in order, as [key, text]: skills, then subagents. */
export function promptSections(skills: readonly Skill[], subagents: readonly Subagent[] = []): Array<[string, string]> {
  const sections: Array<[string, string]> = [];
  const skillCatalog = renderSkillCatalog(skills);
  if (skillCatalog !== undefined) sections.push([SKILLS_SECTION, skillCatalog]);
  const subagentCatalog = renderSubagentCatalog(subagents);
  if (subagentCatalog !== undefined) sections.push([SUBAGENTS_SECTION, subagentCatalog]);
  return sections;
}

/** A section as pi-durable renders a tagged one, so both runtimes send the same prompt. */
export function tagSection(key: string, text: string): string {
  return `<${key}>\n${text}\n</${key}>`;
}

/** The full system prompt: the blueprint's instructions, then each section, tagged. */
export function composeSystemPrompt(
  system: string,
  skills: readonly Skill[],
  subagents: readonly Subagent[] = [],
): string {
  return [system, ...promptSections(skills, subagents).map(([key, text]) => tagSection(key, text))].join("\n\n");
}
