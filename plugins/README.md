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
| `tools/mcp` | tools discovered from MCP servers: `MCP_URL` and the enabled [bundles](#bundles-chatgpt-and-codex-plugins) | `MCP_URL`/`MCP_SERVER_ALIAS`, or bundles; optional auth and protocol settings |

The checked-in [`station.yaml`](../station.yaml) enables xAI, Telegram, Brave, and Notes. MCP is included but disabled by default because it needs a server configuration at startup.

## Enabling local source

`station.yaml` is the reproducible base configuration:

```yaml
plugins:
  - ./plugins/providers/xai
  - ./plugins/channels/telegram
  - ./plugins/tools/brave
  - ./plugins/tools/notes

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

Set `readOnly: true` on a tool that only reads, such as a search: a blueprint with `approval: writes` then runs it without asking. Zing enforces the blueprint's approval before `execute` runs; a tool never has to check it.

The second `execute` argument contains `signal`, `conversationId`, optional `senderId`, optional `approve` (the turn's approver, for a tool that wants its own confirmation), and `capsule: { agentId, state }`. Capsule state is backend-neutral: `read(key)`, `write(key, value)`, and atomic `create(key, value)` use stable slash-separated keys such as `market/cache.json`. Plugins must not depend on a filesystem path. Return model-facing `text` and optional JSON `details`.

The Blueprint is a separate exact allowlist:

```yaml
tools:
  - market__quote
```

There are no wildcards or prefixes. Do not enable two plugins that register the same tool, channel, or provider name; duplicate registration fails instead of silently choosing a winner. The tool names `skill` and `subagent` are reserved for [skills](../skills/README.md) and [subagents](../agents/README.md).

## Channel

A Channel adapts an external message system to the in-process conversation host:

```ts
import type { ZingPluginAPI } from "zing";

export default function discord(zing: ZingPluginAPI) {
  zing.registerChannel({
    id: "discord",
    async start(signal) {
      signal.throwIfAborted();
      const token = zing.requireEnv("DISCORD_BOT_TOKEN");
      await runDiscordClient({
        token,
        signal,
        async onMessage({ chatId, text, senderId }) {
          const result = await zing.host.handleMessage({
            conversationId: zing.conversationId("discord", chatId),
            text,
            senderId,
          });
          await send(result.text);
        },
      });
    },
  });
}
```

To support [approval](../README.md#extensible-by-design), pass `approve(request, signal)` with the message: ask the sender about `request.tool` and `request.input`, and resolve `true` or `false`. The signal aborts when the turn ends first. A channel that processes one update at a time must not block on the turn while it waits, or the answer can never arrive; the Telegram plugin lets go of the update while any question is open. Without `approve`, calls that need approval are declined.

Use `zing.host` inside `start(signal)`, after the Agent has been bound. A Channel must stop accepting work when the signal aborts and resolve `start` after its in-flight handlers settle. If several enabled channels exist, select one with `station.yaml`, `CHANNEL`, or `--channel`. App Server mode does not start a Channel.

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
{ type: "turn", conversationId, senderId?, capsule: { agentId, state }, status, entries }
{ type: "reset", conversationId, capsule: { agentId, state } }
```

Calls are serial for each listener until normal completion or the five-second timeout; different listeners run independently. A timeout or exception warns but never blocks the turn. `onConversation` returns an idempotent unsubscribe function.

Notes uses this observer for passive owner-note distillation. When `ZING_MEMORY_OWNER_IDS` is configured, only matching senders are owners. Without it, only senderless stdio is trusted; identified Telegram senders are untrusted. Explicit `memory_save` records an untrusted sender's fact as untrusted. Do not add the default bot to Telegram groups.

## Client methods

`zing.registerMethod({ name, handle })` offers a JSON-RPC method to [App Server](../docs/app-server.md) clients, for example so a client can render a tool's interface. The name is `<namespace>/<name>` (`mcp/tools/call`); the App Server's own namespaces (`thread`, `turn`, `approval`, `message`, `tool`, `zing`) are reserved. `handle(params, { signal })` receives the client's params as they are and returns JSON; the signal aborts when the connection closes. A thrown error reaches the client as error `-32020` with its message, so check params in the handler. Zing only routes the call: what the method may do is the plugin's decision, and Channels never see it.

A tool's `details` reach clients live, on `tool/completed`, as well as through `thread/read`.

## Bundles: ChatGPT and Codex plugins

A ChatGPT or Codex plugin is a directory in the [Agent Plugins](https://agent-plugins.org) format: a manifest (`plugin.json`, or `.codex-plugin/plugin.json` in OpenAI's [plugins repository](https://github.com/openai/plugins)), Agent Skills under `skills/`, and remote MCP servers in `mcp.json` or `.mcp.json`. Zing calls such a directory a **bundle**. A bundle is data: the Station reads it but never runs code from it.

The three states apply to bundles too:

1. **Included** — copy the plugin directory into your fork, for example `plugins/bundles/notion/`.
2. **Enabled** — list it under `bundles` in `station.yaml` (or `ZING_BUNDLES`). Enabled plugins see it as `zing.bundles`; the MCP plugin connects to its servers.
3. **Allowed** — list its tools in `agent.yaml`, and its skills by the bundle's path:

```yaml
# station.yaml
plugins:
  - ./plugins/tools/mcp
bundles:
  - ./plugins/bundles/notion
```

```yaml
# agent.yaml
tools:
  - notion__notion_search
  - notion__notion_fetch
skills:
  - ./plugins/bundles/notion       # every skill, named notion:<skill>
```

What Zing uses and ignores:

| Part | In Zing |
|---|---|
| `skills/` | Loaded as skills named `<bundle>:<skill>`; see [skills](../skills/README.md). Their `scripts/` are not run. |
| Remote MCP servers (`type: http`) | Connected by the MCP plugin, with OAuth when the server asks for it. |
| Local MCP servers (`command`) | Not started: that would run the bundle's code. Wrap it in a plugin you review instead. |
| `.app.json` apps | Ignored. They name connectors hosted by ChatGPT, which work only there; a bundle with apps but no MCP file gets a warning. |
| hooks, commands, agents | Ignored: Codex features. |

## MCP

The MCP plugin uses the official TypeScript SDK v2. It connects to the server configured by `MCP_URL` and to every remote server of the enabled bundles, discovers their tools once at startup, and registers them as `<server>__<tool>`. Duplicate names fail startup. A tool the server annotates with `readOnlyHint: true` is read-only for `approval: writes`; every other MCP tool asks.

### MCP_URL

One server configured in the environment pins protocol `2026-07-28`:

```bash
export MCP_URL=https://example.com/mcp
export MCP_SERVER_ALIAS=market
export MCP_BEARER_TOKEN=optional-token
export MCP_TOOL_ALIASES='{"get-stock-quote":"quote"}'
```

Enable `./plugins/tools/mcp` in `station.yaml`, then allow the resulting exact name in `agent.yaml`, for example `market__quote`. These names are never rewritten or truncated: a remote name that is not a valid name part needs an entry in `MCP_TOOL_ALIASES`. `input_required` is unsupported. For an explicitly approved legacy server only, set `MCP_PROTOCOL_VERSION=2025-11-25`; otherwise there is no downgrade from `2026-07-28`. Without `MCP_BEARER_TOKEN`, the server may use OAuth as below.

### Bundle servers

A bundle's server is named by its key in the MCP file, and its tools by one documented rule, because published plugins use names like `notion-search` and `getJiraIssue`: lowercase, camelCase and every run of other characters become one `_` (`notion__notion_search`, `atlassian__get_jira_issue`). Run `connect.ts` (below) to print a server's tool names.

They also pin `2026-07-28`. Many published servers still speak only `2025-11-25`; startup then fails and says so. Approve the fallback per server, by its tool prefix:

```bash
MCP_LEGACY_SERVERS=notion,linear
```

Fixed credentials come from the MCP file: Codex `bearer_token_env_var`, `http_headers`, and `env_http_headers`, or a portable `api_key` server read from `MCP_<SERVER>_API_KEY`. A `"<NAME>"` OAuth client placeholder, which OpenAI fills with its own registered client, is read from the environment variable `NAME`; when it is unset, Zing registers its own client.

### OAuth

Servers such as Notion, Linear, Slack, and Atlassian ask for OAuth. The Station has no browser, so authorize once with the plugin's command, then start the Station:

```bash
./node_modules/.bin/tsx plugins/tools/mcp/connect.ts ./plugins/bundles/notion   # a bundle's servers
./node_modules/.bin/tsx plugins/tools/mcp/connect.ts                            # the MCP_URL server
```

It discovers the authorization server, registers Zing as a client when the server allows it, and prints a URL to open. The browser returns to `http://localhost:33418/callback` (or the bundle's `callback_port`). On a VPS or in a container, nothing listens there: copy the address the browser ends on and paste it into the command. In Docker, run it in the container so the credentials land in the volume:

```bash
docker compose run --rm -it --entrypoint ./node_modules/.bin/tsx zing \
  plugins/tools/mcp/connect.ts ./plugins/bundles/notion
```

Credentials are the Station's, not the Capsule's: they are written to `$ZING_HOME/connections/mcp/<server>.json` with mode 0600, and the Station refreshes them there. When a server needs a new authorization, startup or the tool call fails with the command to run. Some servers accept only clients they know; for those, set the client the bundle's placeholder names, or connect them with `MCP_URL` and a token.

### MCP Apps

Servers built for ChatGPT can attach an interactive view to a tool: [MCP Apps](https://github.com/modelcontextprotocol/ext-apps), an HTML `ui://` resource named by the tool's `_meta.ui.resourceUri`. The plugin supports them without UI in core:

- A tool whose `_meta.ui.visibility` leaves out `model` is for its view only, and is not registered as a Zing tool.
- A tool's `details` are the whole MCP result, `structuredContent` and `_meta` included, and reach App Server clients on `tool/completed`.
- `mcp/servers/list`, `mcp/resources/read`, and `mcp/tools/call` let a client find a tool's view, read its HTML, and pass on the view's own tool calls. `mcp/tools/call` only calls tools whose visibility includes `app`. The blueprint's approval does not cover these calls, and a view can make them without the user doing anything: a client should ask the user, outside the view, before a tool the server does not annotate `readOnlyHint` runs. The reference client does.
- `MCP_APPS=1` tells servers that the Station's clients render views (`io.modelcontextprotocol/ui` with `text/html;profile=mcp-app`). Leave it unset for a Station that only talks over Telegram, which shows the text the server returns for the model.

Rendering is the client's job; [`examples/clients/web`](../examples/clients/web) is a reference client. ChatGPT-only `window.openai` features, such as checkout, are not supported.

The plugin returns a disposer, so its connections close on normal exit, startup failure, SIGINT, and SIGTERM. Copy and edit the local source when you need different auth or business policy rather than adding MCP concepts to core.

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
