# Skills

A skill teaches the agent how to do one kind of task: write your weekly report, plan a trip the way you like, review a contract against your checklist. Plugins give the agent capabilities; skills give it the method for using them.

Skills use the [Agent Skills](https://agentskills.io) format, so many instruction-only skills written for other agents work unchanged. A skill is a directory with a `SKILL.md` and, optionally, files it refers to:

```text
skills/weekly-report/
├── SKILL.md
└── references/
    └── format.md
```

## Adding a skill

1. Create the directory and its `SKILL.md`:

   ```markdown
   ---
   name: weekly-report
   description: Write my weekly report from this week's notes. Use when I ask for a weekly report or a summary of my week.
   ---

   1. Call memory_search for this week's notes.
   2. Group them under Done, Next, and Blocked, in the layout of references/format.md.
   3. Keep it under 200 words.
   ```

2. List its path in [`agent.yaml`](../agent.yaml). Paths start with `./`, `../`, or `/` and resolve from the blueprint file's directory:

   ```yaml
   tools:
     - memory_search
   skills:
     - ./skills/weekly-report
   ```

3. Restart the station.

A skill under `skills/` is not active until a blueprint lists it, just as a plugin under `plugins/` does not run until `station.yaml` lists it. Different blueprints in one fork can list different skills.

## Format

| Field | Rule |
|---|---|
| `name` | Required. Up to 64 lowercase letters, digits, and single hyphens. Must equal the directory name. |
| `description` | Required, up to 1024 characters. Say what the skill does and when to use it: the model decides from this alone. |
| Body | Required. The instructions, in Markdown. Keep it focused; move long material into files the instructions name. |

Other frontmatter fields, such as `license` or `allowed-tools`, are accepted and ignored. In particular, `allowed-tools` grants nothing: the model can call only the tools listed in `agent.yaml`.

An invalid skill, a duplicate name, or a missing `SKILL.md` stops the station at startup.

## How the agent uses skills

Every request carries a `<skills>` section in the system prompt with each listed skill's name and description. When a request matches, the model calls the `skill` tool:

- `skill({ name })` returns the instructions.
- `skill({ name, path: "references/format.md" })` returns a text file inside that skill's directory. Paths that leave the directory, including through symbolic links, are refused.
- A result holds at most 2000 lines or 50,000 characters; the result says which `offset` continues it. Files over 1 MiB are refused.

Zing provides `skill` whenever the blueprint lists skills. Do not list it under `tools`, and plugins cannot register a tool with that name.

`SKILL.md` is read at startup, so restart after editing it. Referenced files are read when the model asks for them.

In a long conversation, the loaded instructions can drop out of the model's context along with the turn that loaded them. The `<skills>` list never does, so the model can load a skill again.

## Limits

- **No scripts.** Zing reads skill files; it never executes them, and it warns at startup when a skill has a `scripts/` directory. Work that needs code belongs in a [plugin](../plugins/README.md) tool, which the skill can then tell the model to call.
- **No discovery.** Only the paths in the blueprint load. Nothing is picked up from a directory by itself.
- **Prompt text is trusted.** A skill's instructions steer the model, including how it uses every tool it is allowed. Read a skill you did not write before listing it, as you would a plugin.

## Docker

Compose mounts `./skills` read-only at `/app/skills`, and the image copies it, so skills under `skills/` need no extra step. A skill elsewhere needs its own mount at the path the blueprint names.
