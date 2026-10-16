# Web client with MCP Apps

A browser chat for Zing that also renders [MCP Apps](https://github.com/modelcontextprotocol/ext-apps): the interactive views MCP servers built for ChatGPT attach to their tools. It is an example of what a client does with the [App Server](../../../docs/app-server.md); Zing itself has no UI and no WebSocket.

```bash
cd examples/clients/web
npm install
npm start          # http://localhost:8780
```

It uses the repository's `.env`, `station.yaml`, and `agent.yaml`. Enable `./plugins/tools/mcp` and a bundle or `MCP_URL` server with apps, and allow its tools in `agent.yaml`.

## How it works

```text
┌──────────────────────────┐  WebSocket  ┌──────────────┐  stdio JSON-RPC  ┌──────────────────┐
│ page  localhost:8780     │ ◄─────────► │ server.ts    │ ◄──────────────► │ zing app-server  │
│  chat, approvals         │             │ (bridge)     │                  │  MCP plugin      │
│  ┌────────────────────┐  │             └──────────────┘                  └──────────────────┘
│  │ sandbox :8781      │  │ postMessage
│  │  ┌──────────────┐  │  │ (MCP Apps)
│  │  │ app HTML     │  │  │
│  │  └──────────────┘  │  │
│  └────────────────────┘  │
└──────────────────────────┘
```

- `server.ts` starts one `zing app-server` with `MCP_APPS=1`, so MCP servers know their views will be shown, and relays JSON-RPC to every open page. One process owns the capsule; each page gets the events of the turns it starts. An approval whose page closes is declined.
- The page reads `mcp/servers/list` to learn which Zing tools have a view. On `tool/started` for one of them it reads the view's `ui://` HTML with `mcp/resources/read`, gives it the call's input, and on `tool/completed` passes the `details`, which are the tool's whole MCP result. `thread/read` replays views the same way after a reload.
- App HTML is untrusted. It runs in a sandbox page on a second origin, inside an iframe of the chat page, with the CSP its resource declares set as a header. It talks to the page only through the [AppBridge](https://github.com/modelcontextprotocol/ext-apps) messages: `tools/call` on its own server (`mcp/tools/call`, only tools visible to apps; one the server does not annotate `readOnlyHint` runs only after the user allows it on a card the page draws below the view), `ui/message` (a new turn), `ui/open-link`, and size changes.
- The WebSocket accepts only the page's own origin on `localhost` or `127.0.0.1`, so other sites and rebound DNS names cannot reach the station.

Not included: fullscreen and picture-in-picture display modes, `ui/update-model-context`, and ChatGPT-only `window.openai` features.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8780` | The chat page and its WebSocket. |
| `SANDBOX_PORT` | `PORT + 1` | The sandbox origin. |
| `HOST` | `127.0.0.1` | Listen address. |
| `SANDBOX_URL` | `http://localhost:<SANDBOX_PORT>/sandbox.html` | Where the page loads the sandbox, when a proxy serves it elsewhere. |
| `ALLOWED_HOSTS` | | More `host:port` names the page may be served under, comma-separated. |
