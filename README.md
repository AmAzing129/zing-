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

- **Channels** — where messages arrive and replies leave, such as Telegram.
- **Trigger sources** — other things that wake the agent, such as a schedule or a webhook.
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

## Triggers: the agent can speak first

Everything that wakes the agent is a **trigger**. A user message is the trigger of kind `message`; a scheduled job (`schedule`) or an incoming webhook (`webhook`) is another kind, and a plugin can define more. Every trigger runs one turn in a conversation through the same path:

```diagram
┌────────────────┐ message  ┌──────────────┐  turn   ┌─────────┐
│ Channel        │─────────▶│              │────────▶│ Agent   │
│ (Telegram)     │          │  dispatcher  │◀────────│ capsule │
└────────────────┘          │              │  reply  └─────────┘
┌────────────────┐ schedule │ remembers a  │
│ Trigger source │─────────▶│ route per    │────────▶ channel.send(route)
│ schedule, hook │ webhook  │ conversation │
└────────────────┘          └──────────────┘
```

A trigger may ask for its reply to be delivered. A user message delivers to the chat it came from, and the dispatcher remembers that route for the conversation. A schedule or webhook asks for delivery to the conversation's remembered route, so the reply reaches the user without the user speaking first. An empty reply stays silent.

Automated triggers are framed for the model as `[trigger kind=… source=… at=…; automated event, not typed by the user]`, stored with their kind in the transcript, and never inherit a human sender's trust. The included [`schedule`](plugins/triggers/schedule) plugin lets the agent schedule one-shot or cron jobs for itself (`schedule_create`, `schedule_list`, `schedule_cancel`). The opt-in [`webhook`](plugins/triggers/webhook) plugin turns an authenticated `POST /hooks/<name>` into a trigger. Trigger sources run alongside the channel in a long-running station, not with `--once` or `app-server`.

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

## Deployment environments

The same Zing runtime can be deployed independently on a VPS, a Mac mini, or a single-replica container platform. The current supported contract is intentionally narrow: one resident Node.js 22 process, one writer for each Capsule, and a persistent POSIX filesystem mounted at `ZING_HOME`. Each deployment can keep its own agent and Capsule without changing application code.

Checked-in profiles cover:

- Docker Compose on a VPS — see [`docs/deploy-container.md`](docs/deploy-container.md).
- Native Linux with systemd — use [`deploy/systemd/zing.service`](deploy/systemd/zing.service).
- A Mac mini with launchd — use [`deploy/launchd/com.zing.agent.plist`](deploy/launchd/com.zing.agent.plist).
- Kubernetes or a similar container platform — start from the single-replica [`deploy/kubernetes/statefulset.yaml`](deploy/kubernetes/statefulset.yaml).

Read the full [deployment contract](docs/deployment-contract.md) before operating a long-lived instance. In particular, do not run two processes against one Capsule. A managed cloud database is storage, not an agent execution environment: the host composition now accepts a `CapsuleFactory`, and plugins use backend-neutral Capsule state, but this repository does not yet ship a Postgres adapter or serverless execution model. The webhook trigger is an opt-in plugin that opens a port inside the same single process.

## Run it with Docker

The checked-in [`station.yaml`](station.yaml) enables xAI, Telegram, Brave Search, Notes, and Schedule. Telegram is the default everyday door; the `zing-data` volume preserves the agent behind it.

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

Edit [`agent.yaml`](agent.yaml) to change the agent's instructions, model, limits, or tool allowlist. Add or edit local source under [`plugins/`](plugins/README.md), then explicitly add its path to [`station.yaml`](station.yaml). Compose mounts both files and the plugin source into the container, so a restart is enough; no image rebuild is needed. Stop the station with `docker compose down`; the volume remains, so the same agent returns on the next `up`.
