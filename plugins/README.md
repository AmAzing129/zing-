# Local plugins

Plugins are ordinary local TypeScript or JavaScript modules. They live in the same fork as the agent, can be read and changed with the rest of the code, and do not need to be published to npm. Contributions merged into this repository are simply project plugins; private integrations can remain changes in your own checkout.

Three states are deliberately separate:

1. **Included** — source exists under `plugins/`.
2. **Enabled** — its path appears in `station.yaml`, `ZING_PLUGINS`, or a `--plugin` flag, so its factory executes inside the Station process.
3. **Allowed** — a registered tool's exact name appears in `agent.yaml`, so the model can call it.

An included plugin is not enabled automatically. This matters because plugin code is trusted in-process code: it can read environment variables, access the filesystem and network, and observe conversations. Review both the code and the `station.yaml` diff before activating a plugin, especially when an agent wrote it.

## Included plugins

| Path | Capability | Configuration |
|---|---|---|
| `providers/xai` | xAI model provider | `XAI_API_KEY` |
| `channels/telegram` | Telegram channel | `TELEGRAM_BOT_TOKEN`, optional `TELEGRAM_ALLOWED_USER_IDS` |
| `tools/brave` | `web_search` | `BRAVE_API_KEY` |
| `tools/notes` | `memory_search`, `memory_save`, conversation observer | optional `ZING_MEMORY_OWNER_IDS` |
| `tools/mcp` | tools discovered from one MCP server | `MCP_URL`, `MCP_SERVER_ALIAS`, and optional auth/alias settings |
| `triggers/schedule` | `schedule` trigger source; `schedule_create`, `schedule_list`, `schedule_cancel` | optional `ZING_TIMEZONE` |
| `triggers/webhook` | `webhook` trigger source on `POST /hooks/<name>` | `ZING_WEBHOOK_TOKEN`, optional `ZING_WEBHOOK_HOST`, `ZING_WEBHOOK_PORT`, `ZING_WEBHOOK_CONVERSATION` |

The checked-in [`station.yaml`](../station.yaml) enables xAI, Telegram, Brave, Notes, and Schedule. MCP and Webhook are included but disabled by default: MCP needs a server configuration at startup, and Webhook opens a network port.

## Enabling local source

`station.yaml` is the reproducible base configuration:

```yaml
plugins:
  - ./plugins/providers/xai
  - ./plugins/channels/telegram
  - ./plugins/tools/brave
  - ./plugins/tools/notes
  - ./plugins/triggers/schedule

channel: telegram
```

Plugin paths are ordered and resolved relative to the config file. Zing reads `./station.yaml`, then `$ZING_HOME/station.yaml` (`~/.zing` by default); use `ZING_STATION` or `--station` to select another file. `ZING_PLUGINS` and repeatable `--plugin` flags append paths in that order. For channel and provider selection, CLI overrides environment, which overrides `station.yaml`:

```bash
ZING_PLUGINS=./plugins/tools/my_private_tool npm start

./node_modules/.bin/tsx src/index.ts \
  --plugin ./plugins/tools/my_private_tool \
  --channel telegram
```

A plugin path can be a `.ts`/`.js` file or a directory. A directory uses `package.json` `zing.plugin`, then `main`, then `index.ts`, `index.mts`, `index.mjs`, or `index.js`. The repository's `plugins/package.json` provides the ESM scope. A plugin elsewhere should provide its own `package.json` with `"type": "module"`.

## Tool

Plugins expose model-callable capabilities with `registerTool`:

```ts
import { Type } from "@earendil-works/pi-ai";
import type { ZingPluginAPI } from "zing";

export default function market(zing: ZingPluginAPI) {
  zing.registerTool({
    name: "market__quote",
    description: "Get the latest quote for a symbol.",
    parameters: Type.Object({ symbol: Type.String() }),
    async execute(input, context) {
      const symbol = String(input.symbol);
      return { text: "42", details: { symbol, price: 42 } };
    },
  });
}
```

The second `execute` argument contains `signal`, `conversationId`, optional `senderId`, `trigger: { kind, source? }` describing what started the turn, and `capsule: { agentId, state }`. Capsule state is backend-neutral: `read(key)`, `write(key, value)`, and atomic `create(key, value)` use stable slash-separated keys such as `market/cache.json`. Plugins must not depend on a filesystem path. Return model-facing `text` and optional JSON `details`.

The Blueprint is a separate exact allowlist:

```yaml
tools:
  - market__quote
```

There are no wildcards or prefixes. Do not enable two plugins that register the same tool, channel, or provider name; duplicate registration fails instead of silently choosing a winner.

## Triggers

Everything that wakes the agent is a trigger. `zing.host.dispatch(trigger)` runs one turn in the trigger's conversation, queued behind any other turn there, and resolves with the reply:

```ts
type Trigger = {
  kind: string;            // "message" for a user message; "schedule", "webhook", or your own kind
  source?: string;         // which source fired it, e.g. "schedule:sch_1"
  conversationId: string;
  text: string;
  senderId?: string;       // a human sender; only message triggers may carry one
  deliver?: { channel: string; to: string } | "conversation";
};
```

`deliver` decides where the reply goes:

- A route `{ channel, to }` sends the reply through that channel's `send` and remembers the route for the conversation in the capsule.
- `"conversation"` sends the reply to the conversation's remembered route. With no route yet, the turn still runs and stays in the conversation.
- Omitted: nothing is sent; the caller uses the returned text. `zing.host.handleMessage(message)` is this case for a message trigger.

A blank reply is never sent, so a proactive turn can decide to stay silent. The model sees an automated trigger as `[trigger kind=… source=… at=…; automated event, not typed by the user]` followed by its text; the transcript stores the raw text with `trigger: { kind, source }`, and `thread/read` returns the same field.

## Channel

A Channel is a two-way trigger source: it fires message triggers and, with `send`, delivers replies, including ones the user did not ask for:

```ts
import type { ZingPluginAPI } from "zing";

export default function discord(zing: ZingPluginAPI) {
  zing.registerChannel({
    id: "discord",
    async send({ to, text }) {
      await sendDiscordMessage(zing.requireEnv("DISCORD_BOT_TOKEN"), to, text);
    },
    async start(signal) {
      signal.throwIfAborted();
      const token = zing.requireEnv("DISCORD_BOT_TOKEN");
      await runDiscordClient({
        token,
        signal,
        async onMessage({ chatId, text, senderId }) {
          await zing.host.dispatch({
            kind: "message",
            conversationId: zing.conversationId("discord", chatId),
            text,
            senderId,
            deliver: { channel: "discord", to: chatId },
          });
        },
      });
    },
  });
}
```

Use `zing.host` inside `start(signal)`, after the Agent has been bound. `send` may be called whenever a trigger's reply is due, including before `start` or by another source, so it should create its client lazily. A Channel must stop accepting work when the signal aborts and resolve `start` after its in-flight handlers settle. If several enabled channels exist, select one with `station.yaml`, `CHANNEL`, or `--channel`. App Server mode does not start a Channel.

## Trigger source

A trigger source wakes the agent without a user message. It runs next to the selected channel in a long-running station; `--once` and App Server mode do not start trigger sources:

```ts
import type { ZingPluginAPI } from "zing";

export default function feed(zing: ZingPluginAPI) {
  zing.registerTriggerSource({
    id: "feed",
    async start(signal) {
      for await (const item of watchFeed(signal)) {
        await zing.host.dispatch({
          kind: "feed",
          source: `feed:${item.id}`,
          conversationId: "telegram:12345",
          text: `New post: ${item.title}\n${item.url}`,
          deliver: "conversation",
        });
      }
    },
  });
}
```

`start` must run until the signal aborts and then resolve after in-flight dispatches settle. If any trigger source or the channel fails, the station stops the others and exits with that error. `zing.capsule` gives a source the same backend-neutral state that tools receive, for example to persist its own jobs.

### Schedule

`triggers/schedule` gives the model three tools, scoped to the conversation they are called in. `schedule_create` accepts one of `at` (ISO 8601 with an offset), `in_minutes`, or a five-field `cron` with an optional IANA `timezone` (default `ZING_TIMEZONE` or the station's timezone). Jobs live in capsule state at `schedule/jobs.json`. A job is recorded as run before its turn starts, so a crash never replays it. A one-shot job missed while the station was down fires once on the next start; a recurring job skips missed occurrences. Allow the tools in `agent.yaml` to let the agent schedule itself.

### Webhook

`triggers/webhook` listens on `ZING_WEBHOOK_HOST:ZING_WEBHOOK_PORT` (default `127.0.0.1:8787`):

```bash
curl -X POST "http://127.0.0.1:8787/hooks/ci?conversation=telegram:12345" \
  -H "Authorization: Bearer $ZING_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"text":"Build #7 failed on main"}'
```

A JSON body with a string `text` uses that text; any other body up to 64 KiB is passed through verbatim. The request returns `202` before the turn runs, and the reply goes to the conversation's remembered route. `?token=` is accepted for senders that cannot set headers, but it may end up in proxy logs. Expose the port deliberately; the container and Kubernetes templates do not publish it.

## Provider

The Blueprint names a model ID; an enabled provider supplies its model catalog and key. The ID is required and Zing has no built-in default model. Set `model` in `agent.yaml`; a `MODEL` environment variable overrides it for one station:

```ts
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { ZingPluginAPI } from "zing";

export default function xai(zing: ZingPluginAPI) {
  zing.registerProvider({
    pluginId: "xai",
    provider: xaiProvider(),
    getApiKey: () => zing.env.XAI_API_KEY?.trim() || undefined,
  });
}
```

When several providers can serve the same model ID, select one with `station.yaml`, `PROVIDER`, or `--provider`. Otherwise leave it unset and let the Station resolve the unique match.

The model ID must be in an enabled provider's catalog; otherwise startup fails and lists the available IDs. Zing does not guess metadata for an unlisted ID, because the context window and output limit drive history trimming. To use a model the catalog does not list yet, add it in the provider plugin with its real limits:

```ts
const base = xaiProvider();
const template = base.getModels().find((model) => model.id === "grok-4.5");
if (!template) throw new Error("grok-4.5 template missing");
const grok5 = { ...template, id: "grok-5", name: "Grok 5", contextWindow: 1_000_000, maxTokens: 128_000 };

zing.registerProvider({
  pluginId: "xai",
  provider: { ...base, getModels: () => [...base.getModels(), grok5] },
  getApiKey: () => zing.env.XAI_API_KEY?.trim() || undefined,
});
```

## Observing conversations

`zing.onConversation(listener)` subscribes to persisted activity. The listener receives `(event, signal)`, where an event is either:

```ts
{ type: "turn", conversationId, senderId?, trigger: { kind, source? }, capsule: { agentId, state }, status, entries }
{ type: "reset", conversationId, capsule: { agentId, state } }
```

Calls are serial for each listener until normal completion or the five-second timeout; different listeners run independently. A timeout or exception warns but never blocks the turn. `onConversation` returns an idempotent unsubscribe function.

Notes uses this observer for passive owner-note distillation. When `ZING_MEMORY_OWNER_IDS` is configured, only matching senders are owners. Without it, only senderless stdio is trusted; identified Telegram senders are untrusted. Automated triggers (schedule, webhook, ...) are always untrusted. Explicit `memory_save` records an untrusted sender's fact as untrusted. Do not add the default bot to Telegram groups.

## MCP

The MCP plugin uses the official TypeScript SDK v2 and pins protocol `2026-07-28`. It discovers tools once at startup and registers them as `<serverAlias>__<toolAlias>`:

```bash
export MCP_URL=https://example.com/mcp
export MCP_SERVER_ALIAS=market
export MCP_BEARER_TOKEN=optional-token
export MCP_TOOL_ALIASES='{"get-stock-quote":"quote"}'
```

Enable `./plugins/tools/mcp` in `station.yaml`, then allow the resulting exact name in `agent.yaml`, for example `market__quote`. Names are never silently rewritten or truncated. `input_required` is unsupported. For an explicitly approved legacy server only, set `MCP_PROTOCOL_VERSION=2025-11-25`; otherwise there is no downgrade from `2026-07-28`.

The plugin returns a disposer, so its connection closes on normal exit, startup failure, SIGINT, and SIGTERM. Copy and edit the local source when you need different auth or business policy rather than adding MCP concepts to core.

## Dependencies

- With only `fetch` and Node built-ins, add an `index.ts` and enable its path.
- For npm dependencies, add a `package.json` inside the plugin directory and install there. The package is local metadata; it does not need to be published.
- In Docker, install dependencies inside the container so `node_modules`, Linux, and Node versions agree:

  ```bash
  docker compose run --rm -v ./plugins:/app/plugins --entrypoint npm zing \
    install --prefix /app/plugins/tools/<name>
  ```

  The extra volume flag makes the plugin tree writable only for this install command; the long-running service mounts it read-only.

- For a native addon or dependencies baked into the Station, derive the Dockerfile. That changes the Station, not the Agent's Capsule.
