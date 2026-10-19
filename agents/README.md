# Subagents

A subagent is a specialist the agent can hand one self-contained task to: research a question across many searches, review a draft against your checklist, or answer with a cheaper or stronger model. It works in a fresh context and returns only its final answer, so the long middle of the task does not fill the main conversation.

Plugins give the agent capabilities, skills give it methods, and subagents give it someone to delegate to. A subagent is a [blueprint](../agent.yaml) in Markdown: blueprint fields as frontmatter, then its instructions. The format is close to the subagent files of Claude Code and similar tools, so their `name`, `description`, and instructions carry over; their tool names do not.

## Adding a subagent

1. Create the file. Its name is the file name without `.md`:

   ```markdown
   ---
   name: researcher
   description: Answer questions that need several searches and checked sources. Use for research, not for quick facts.
   tools: [web_search]
   limits:
     maxToolCalls: 12
   ---

   Search until two independent sources agree, then answer in under 150 words with their links.
   Say plainly when the sources disagree.
   ```

2. List its path in [`agent.yaml`](../agent.yaml). Paths start with `./`, `../`, or `/` and resolve from the blueprint file's directory:

   ```yaml
   tools:
     - web_search
     - memory_search
   agents:
     - ./agents/researcher.md
   ```

3. Restart the station.

A file under `agents/` is not active until a blueprint lists it, just as a plugin under `plugins/` does not run until `station.yaml` lists it.

## Format

| Field | Rule |
|---|---|
| `name` | Required. Up to 64 lowercase letters, digits, and single hyphens. Must equal the file name without `.md`. |
| `description` | Required, up to 1024 characters. Say what the subagent does and when to use it: the main agent decides from this alone. |
| `model` | Optional model ID, served by an enabled provider like the main agent's. Omitted or `inherit`: the main agent's model, including a `MODEL` override. |
| `tools` | Optional exact tool names. Each must also be in the main agent's `tools`. Omitted: no tools. |
| `skills` | Optional skill directory paths, resolved from the subagent file's directory. The subagent gets its own `skill` tool for them. |
| `limits` | Optional, as in `agent.yaml`. Defaults: 5 minutes, 16 model turns, 32 tool calls. |
| Body | Required. The subagent's instructions: its whole system prompt. |

Other frontmatter fields are accepted and ignored. A subagent cannot set `system` (write the instructions in the body) or list `agents`.

An invalid subagent, a tool the main agent does not have, an unknown model, or a duplicate name stops the station at startup.

## How the agent uses subagents

Every request carries a `<subagents>` section in the system prompt with each listed subagent's name and description. When a task matches, the model calls the `subagent` tool with the subagent's name and the task. The subagent then runs inside that tool call:

- It sees its own instructions, its skills, and the task, never the main conversation. The task must say everything it needs.
- Its tools act for the conversation and sender that delegated, so a tool such as `memory_save` treats the sender the same way it would for the main agent.
- Its final answer is the tool result. The tool result's details keep the subagent's whole exchange, which `thread/read` returns with the thread.
- A subagent that exceeds its limits or fails returns an error to the main agent, which can continue without it. Canceling the main turn, or the main turn timing out, stops the subagent.
- It is not a thread and does not reach conversation observers, so a memory plugin never mistakes a task the model wrote for something the sender said.

Zing provides `subagent` whenever the blueprint lists agents. Do not list it under `tools`, and plugins cannot register a tool with that name.

The subagent file is read at startup, so restart after editing it.

## Limits

- **No new capabilities.** A subagent can use only tools the main agent already has. `agent.yaml` stays the one list to review for what the agent can do.
- **One level.** A subagent cannot delegate to another subagent.
- **Budgets add up.** Each delegation counts as one tool call of the main turn, and the subagent spends its own budget inside it. The main turn's timeout bounds both. Give a subagent tight `limits`.
- **Not resumed after a crash.** On the durable runtime, a station that restarts during a delegation gives the main agent an interrupted result, as for any plugin tool; the subagent does not continue where it stopped.
- **Prompt text is trusted.** A subagent's instructions steer how it uses every tool it is allowed. Read a subagent file you did not write before listing it, as you would a skill or plugin.

## Docker

Compose mounts `./agents` read-only at `/app/agents`, and the image copies it, so subagents under `agents/` need no extra step.
