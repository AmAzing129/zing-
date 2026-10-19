# zing

**A personal agent should feel less like a product you operate and more like a friend you keep.**

Zing is a small, durable runtime for personal agents. It gives an agent an identity, a persistent life, and clear boundaries; you decide how to talk to it and which capabilities it has.

Zing was inspired by OpenClaw and pi. OpenClaw showed what an ambitious personal-agent system can be; pi showed how much power can come from a simple, extensible foundation. Zing takes those lessons in a deliberately narrower direction: a lightweight core, a portable agent identity, and plugins for everything that belongs at the edge.

## The idea

People do not need one omniscient assistant that tries to do everything. They need a few distinct companions: one may help every day, another may only matter once a year. Each should remain itself between conversations, even while the place you meet changes.

Zing models that distinction explicitly:

| Concept | Meaning |
| --- | --- |
| **Blueprint** | The kind of agent: its name, model, instructions, limits, and allowed tools. |
| **Capsule** | This particular agent: its stable identity, conversations, and optional memories. |
| **Station** | The running process: model providers, channels, credentials, and plugins. |

Restart or replace the station and the capsule is still the same agent. Create a new capsule and you have a new individual, even if it uses the same blueprint. In Docker, the station is the container; the capsule lives in the volume, not the image.

## Local first

Zing is meant to be forked, read, and changed—not treated as a remote service or a sealed dependency. A fork is a working personal-agent station. Its behavior is ordinary TypeScript and YAML, so you or a coding agent with explicitly granted local tools can inspect it, add an integration, run the tests, and keep the result in the fork.

Plugins follow the same rule. They are local source modules, not marketplace artifacts. Code accepted into this repository lives under [`plugins/`](plugins/); private changes can stay only in your checkout. A `package.json` is useful when a plugin needs its own dependencies or entry point, but publishing to npm is not part of the contract.

Local does not mean implicit. [`station.yaml`](station.yaml) is the reviewable trust list of plugin paths that execute in the process; merely placing code under `plugins/` does not enable it. [`agent.yaml`](agent.yaml) separately lists the exact tools the model may call. This keeps a fork easy to extend while making activation reproducible and visible in a diff—especially when an agent helped write the code.

## Extensible by design

The core should not grow a new integration every time someone wants a new interface. Telegram, a custom web app, a CLI, Slack, a search provider, memory, and domain-specific tools are local plugins or clients—not core features.

That keeps Zing small and makes it yours. You can write the small piece of code that connects your agent to the places and services you actually use. Coding is no longer reserved for a small group of people, so personal software should be personalizable too.

Plugins can provide:

- **Channels** — where messages arrive, such as Telegram.
- **Model providers** — which model serves the blueprint's model ID.
- **Tools** — explicit capabilities the model may call, from web search to your own APIs.
- **Memory** — a projection of useful conversation facts, rather than a second transcript.

The blueprint is an exact capability allowlist: an enabled tool is invisible to the model until you name it in `agent.yaml`.

```yaml
name: research-friend
model: grok-4.6
tools:
  - web_search
  - market__quote
```

See [`plugins/README.md`](plugins/README.md) for the local plugin contract, activation rules, and included implementations.

### Skills

Plugins give an agent capabilities; skills teach it how to use them for one kind of task, such as writing your weekly report. A skill is a directory with a `SKILL.md` in the [Agent Skills](https://agentskills.io) format, listed by path in the blueprint:

```yaml
skills:
  - ./skills/weekly-report
```

The model sees each listed skill's name and description and loads the full instructions with the built-in `skill` tool only when a request needs them. A skill is text: it cannot add tools beyond the blueprint's allowlist, and Zing never runs its scripts. See [`skills/README.md`](skills/README.md) for the format and rules.

### Subagents

A subagent is a specialist the agent can delegate one self-contained task to, such as research that takes many searches. It is a blueprint written as Markdown, with its own instructions, model, tools, and limits, and it is listed by path like a skill:

```yaml
agents:
  - ./agents/researcher.md
```

The model sees each listed subagent's name and description and delegates with the built-in `subagent` tool. The subagent works in a fresh context inside that tool call and returns only its final answer. Its tools must be a subset of the blueprint's, so delegating never grants a capability. See [`agents/README.md`](agents/README.md) for the format and rules.

## A runtime, not a UI

Zing owns the agent's identity, threads, turns, persistence, tool execution, cancellation, and recovery. A client owns the interaction experience. This separation means one agent can be reached through Telegram today and a web or desktop client tomorrow without moving its life into a UI framework.

Zing v1 exposes a UI-free JSON-RPC 2.0 App Server over stdio. Clients write JSONL to stdin and receive responses and streaming events from stdout; logs always go to stderr. The protocol has no dependency on AG-UI, ACP, or any frontend framework.

```bash
./node_modules/.bin/tsx src/index.ts app-server
```

Try it with the minimal client:

```bash
./node_modules/.bin/tsx examples/clients/stdio.ts "Hello"
```

The process reads the same `station.yaml` as channel mode. [`docs/app-server.md`](docs/app-server.md) describes the protocol, streaming events, concurrency, and recovery semantics. The machine-readable schema is [`schemas/zing-protocol-v1.json`](schemas/zing-protocol-v1.json).

## Durable conversations, bounded work

The capsule retains the full transcript after a reset. When history approaches the model's context window, Zing leaves the oldest complete turns out of the next model request while preserving the atomic user, assistant, tool-call, and tool-result boundaries of recent turns. This is context management, not deletion: omitted history remains in the capsule, and facts distilled by a memory plugin can later be found with `memory_search`.

Each turn is bounded by default to 5 minutes, 16 model rounds, and 32 tool calls so a runaway loop cannot consume quota indefinitely. Tighten the limits in the blueprint when appropriate:

```yaml
limits:
  turnTimeoutMs: 120000
  maxModelTurns: 8
  maxToolCalls: 16
```

A turn that exceeds a limit ends as `failed`, but its completed transcript remains durable. Plugin tools receive an `AbortSignal` through `ToolContext`; Zing stops waiting once a turn is canceled or out of budget, even if a plugin does not cooperate.

### Durable runtime (experimental)

By default the capsule keeps each thread as a JSONL transcript, written when a turn ends. A crash mid-turn loses that turn. Set `runtime: durable` in `station.yaml` (or `ZING_RUNTIME=durable`) to run the capsule on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) instead:

- Every user message, model response, and tool result is committed to `durable.sqlite` in the capsule before it is shown.
- A restarted station resumes the turns it left unfinished. An interrupted tool call is not run again; the model receives an `interrupted` result and continues.
- A redelivered message with the same request ID returns the original turn's outcome without running it again. Telegram keys requests by bot, chat, and message ID, not the reusable update ID.
- Threads, turns, events, limits, plugins, and the App Server protocol behave as before. Existing JSONL threads are imported, from their last reset, the first time the durable runtime opens the capsule; the JSONL files stay untouched, so switching back to `legacy` does not see later turns.

A graceful station stop first stops intake and drains the channel. Telegram finishes in-flight replies; App Server protocol v1 cancels its connection's turns and waits for cancellation before the runtime closes. The drain lasts at most 50 seconds: turns still running then are canceled, as the legacy runtime does at a stop, and their callers are told (Telegram replies with its failure message). None of them resumes after the restart for a caller that is gone, and the rest of the 60-second forced-exit limit records the cancellation. Directly closing the runtime leaves unfinished, uncanceled turns pending for restart.

A resumed turn keeps its spent model/tool budget and its persisted deadline: downtime counts toward the timeout. A budget failure is stored in the submission itself, and startup cancels any leftover execution before resuming tasks. The first committed terminal outcome wins; a timeout queued behind an admitted answer commit cannot retroactively turn that answer into a failure. Observers use one settlement path for live turns, recovery, and redelivery, with durable per-turn acknowledgments rather than a global settlement watermark (pi-durable 1.2.0 does not expose a settlement-ordered replay log).

A storage error stops the runtime: pi-durable does not retry it, so the station stops taking turns and exits non-zero for its supervisor to restart it. The restart continues from what was committed. A turn in flight is told it resumes after the restart, including a canceled one whose cancellation had not been committed yet.

Turn deduplication is not exactly-once reply delivery. Telegram acknowledges an update before its handler finishes during shutdown; a crash during that drain still loses the reply, and the turn then resumes without a recipient. There is no durable reply outbox yet, and a crash after sending but before acknowledging can cause a repeated reply. Existing `update:*` request IDs from earlier preview revisions are not migrated to the new Telegram keys.

An unreadable JSONL thread is reported and left unavailable without blocking other threads; its history is never replaced with an empty conversation. Import runs once per thread: switching back to legacy, adding messages, and switching to durable again does not merge those later JSONL messages. pi-durable is experimental upstream, so Zing pins its exact version.

## Deployment environments

The same Zing runtime can be deployed independently on a VPS, a Mac mini, or a single-replica container platform. The current supported contract is intentionally narrow: one resident Node.js 22 process, one writer for each Capsule, and a persistent POSIX filesystem mounted at `ZING_HOME`. Each deployment can keep its own agent and Capsule without changing application code.

Checked-in profiles cover:

- Docker Compose on a VPS — see [`docs/deploy-container.md`](docs/deploy-container.md).
- Native Linux with systemd — use [`deploy/systemd/zing.service`](deploy/systemd/zing.service).
- A Mac mini with launchd — use [`deploy/launchd/com.zing.agent.plist`](deploy/launchd/com.zing.agent.plist).
- Kubernetes or a similar container platform — start from the single-replica [`deploy/kubernetes/statefulset.yaml`](deploy/kubernetes/statefulset.yaml).

Read the full [deployment contract](docs/deployment-contract.md) before operating a long-lived instance. In particular, do not run two processes against one Capsule. A managed cloud database is storage, not an agent execution environment: the host composition now accepts a `CapsuleFactory`, and plugins use backend-neutral Capsule state, but this repository does not yet ship a Postgres adapter, webhook channel, or serverless execution model.

## Run it with Docker

The checked-in [`station.yaml`](station.yaml) enables xAI, Telegram, Brave Search, and Notes. Telegram is the default everyday door; the `zing-data` volume preserves the agent behind it.

1. Create a bot with [BotFather](https://t.me/BotFather) and copy its token. Find your numeric Telegram ID with [@userinfobot](https://t.me/userinfobot).
2. Create your local secrets file:

   ```bash
   cp .env.example .env
   ```

   Set `XAI_API_KEY`, `BRAVE_API_KEY`, `TELEGRAM_BOT_TOKEN`, and `TELEGRAM_ALLOWED_USER_IDS`. The Notes plugin loads by default. Set `ZING_MEMORY_OWNER_IDS` to the trusted Telegram owner IDs to passively distill their facts. Without it, identified Telegram senders are untrusted and do not receive passive owner-note distillation; the model can still explicitly call `memory_save`, which stores those facts as untrusted.

3. Start the station:

   ```bash
   docker compose up -d --build
   docker compose logs -f
   ```

   When `Telegram channel @yourbot is running` appears, message the bot. Use `/reset` to begin a fresh conversation.

4. To test the keys without connecting Telegram:

   ```bash
   docker compose run --rm zing --once "Hello"
   ```

Edit [`agent.yaml`](agent.yaml) to change the agent's instructions, model, limits, tool allowlist, skills, or subagents. Add or edit local source under [`plugins/`](plugins/README.md), then explicitly add its path to [`station.yaml`](station.yaml); add skills under [`skills/`](skills/README.md) and subagents under [`agents/`](agents/README.md) and list them in `agent.yaml`. Compose mounts both files, the plugin source, the skills, and the subagents into the container, so a restart is enough; no image rebuild is needed. Stop the station with `docker compose down`; the volume remains, so the same agent returns on the next `up`.
