/**
 * A browser chat for Zing that also renders MCP Apps: the interactive views MCP servers attach to their tools.
 *
 *   cd examples/clients/web && npm install && npm start
 *
 * It starts one `zing app-server` for the repository's station, with MCP_APPS=1, and relays its JSON-RPC to each
 * open page over WebSocket. Zing itself stays stdio-only. App HTML is untrusted, so it runs on another origin:
 *
 *   http://localhost:8780   the chat page and its WebSocket
 *   http://localhost:8781   the sandbox that runs app views, inside an iframe of the page
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";
import { WebSocketServer, type WebSocket } from "ws";

type Message = Record<string, unknown>;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const listenHost = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8780);
const sandboxPort = Number(process.env.SANDBOX_PORT ?? port + 1);
/** Where the page loads the sandbox. Behind a proxy, set the sandbox's public URL. */
const sandboxUrl = process.env.SANDBOX_URL ?? `http://localhost:${sandboxPort}/sandbox.html`;
/** Host names the page may be served under. Others are refused, so a rebound DNS name cannot reach the station. */
const allowedHosts = new Set([
  `localhost:${port}`,
  `127.0.0.1:${port}`,
  ...(process.env.ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean),
]);

const scripts = await bundleScripts();
const zing = startZing();
const pages = createServer((request, response) => void servePage(request, response));
const sandbox = createServer((request, response) => void serveSandbox(request, response));
const sockets = new WebSocketServer({ noServer: true });

pages.on("upgrade", (request, socket, head) => {
  if (!sameOrigin(request)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  sockets.handleUpgrade(request, socket, head, (ws) => zing.attach(ws));
});
pages.listen(port, listenHost);
sandbox.listen(sandboxPort, listenHost);
console.error(`Zing web client: http://localhost:${port}`);

/** One App Server for every page, so one process owns the capsule. Each page sees its own requests and turns. */
function startZing() {
  const child = spawn(join(root, "node_modules/.bin/tsx"), ["src/index.ts", "app-server"], {
    cwd: root,
    env: { ...process.env, MCP_APPS: process.env.MCP_APPS ?? "1" },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.once("exit", (code) => {
    console.error(`zing app-server exited (${code ?? "signal"})`);
    process.exit(1);
  });
  const write = (message: Message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  let nextId = 1;
  /** Requests in flight, by the ID the bridge gave them. */
  const calls = new Map<number, { socket?: WebSocket; id: unknown; method: string; done?: (message: Message) => void }>();
  /** The page that started each turn receives its events. */
  const owners = new Map<string, WebSocket>();
  /** Approvals sent to a page, declined if the page goes away. */
  const approvals = new Map<string, WebSocket>();

  const ask = (method: string, params: unknown): Promise<Message> =>
    new Promise((done) => {
      const id = nextId++;
      calls.set(id, { id, method, done });
      write({ jsonrpc: "2.0", id, method, params });
    });
  const decline = (approvalId: string) => {
    approvals.delete(approvalId);
    void ask("approval/respond", { approvalId, approved: false });
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Message;
    if (typeof message.id === "number" && message.method === undefined) {
      const call = calls.get(message.id);
      calls.delete(message.id);
      if (!call) return;
      if (call.done) return call.done(message);
      const turn = (message.result as { turn?: { id?: unknown } } | undefined)?.turn;
      if (call.method === "turn/start" && typeof turn?.id === "string" && call.socket) owners.set(turn.id, call.socket);
      if (call.socket) send(call.socket, { ...message, id: call.id });
      return;
    }
    const params = (message.params ?? {}) as Message;
    const turnId = String(params.turnId);
    const owner = owners.get(turnId);
    if (message.method === "turn/completed") owners.delete(turnId);
    if (!owner || owner.readyState !== owner.OPEN) {
      if (message.method === "approval/requested") decline(String(params.approvalId));
      return;
    }
    if (message.method === "approval/requested") approvals.set(String(params.approvalId), owner);
    send(owner, message);
  });

  const initialized = ask("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "zing-web-example", version: "0.1.0" },
    capabilities: { approvals: true },
  });

  return {
    attach(socket: WebSocket) {
      socket.on("message", async (data) => {
        let message: Message;
        try {
          message = JSON.parse(String(data)) as Message;
        } catch {
          return;
        }
        if (message.id === undefined || typeof message.method !== "string") return;
        // The bridge initialized the App Server once; every page shares that session.
        if (message.method === "initialize") {
          const { result, error } = await initialized;
          send(socket, { jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) });
          return;
        }
        if (message.method === "approval/respond") approvals.delete(String((message.params as Message)?.approvalId));
        const id = nextId++;
        calls.set(id, { socket, id: message.id, method: message.method });
        write({ ...message, id });
      });
      socket.on("close", () => {
        for (const [approvalId, owner] of approvals) if (owner === socket) decline(approvalId);
      });
    },
  };
}

async function servePage(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (!allowedHosts.has(request.headers.host ?? "")) return void response.writeHead(403).end();
  const headers = { "cache-control": "no-store", "content-security-policy": "frame-ancestors 'none'" };
  if (path === "/") {
    const html = await readFile(join(here, "public/index.html"), "utf8");
    response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(html);
  } else if (path === "/app.js") {
    response.writeHead(200, { ...headers, "content-type": "text/javascript" }).end(scripts.get("app.js"));
  } else if (path === "/config.json") {
    response.writeHead(200, { ...headers, "content-type": "application/json" }).end(JSON.stringify({ sandboxUrl }));
  } else {
    response.writeHead(404).end();
  }
}

/** The sandbox page, with the CSP the app's resource asked for, set as a header the app cannot change. */
async function serveSandbox(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/sandbox.js") {
    response.writeHead(200, { "content-type": "text/javascript" }).end(scripts.get("sandbox.js"));
    return;
  }
  if (url.pathname !== "/sandbox.html") return void response.writeHead(404).end();
  let csp: Record<string, unknown> = {};
  try {
    csp = JSON.parse(url.searchParams.get("csp") ?? "{}") as Record<string, unknown>;
  } catch {
    // An unreadable policy grants nothing extra.
  }
  const html = await readFile(join(here, "public/sandbox.html"), "utf8");
  response
    .writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": sandboxPolicy(csp),
      "cache-control": "no-store",
    })
    .end(html);
}

/** MCP Apps CSP: the view reaches only the domains its resource declares. */
function sandboxPolicy(csp: Record<string, unknown>): string {
  const domains = (key: string) => {
    const value = csp[key];
    // A quote, semicolon, comma, or space would smuggle in another source or directive.
    const list = Array.isArray(value) ? value.filter((item) => typeof item === "string" && !/[\s;,'"]/.test(item)) : [];
    return list.join(" ");
  };
  const resources = domains("resourceDomains");
  const frames = domains("frameDomains");
  const bases = domains("baseUriDomains");
  return [
    "default-src 'self' 'unsafe-inline'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data: ${resources}`,
    `style-src 'self' 'unsafe-inline' blob: data: ${resources}`,
    `img-src 'self' data: blob: ${resources}`,
    `font-src 'self' data: blob: ${resources}`,
    `media-src 'self' data: blob: ${resources}`,
    `connect-src 'self' ${domains("connectDomains")}`,
    `worker-src 'self' blob: ${resources}`,
    frames ? `frame-src ${frames}` : "frame-src 'none'",
    bases ? `base-uri ${bases}` : "base-uri 'none'",
    "object-src 'none'",
  ]
    .map((directive) => directive.trim())
    .join("; ");
}

/** WebSocket from the page itself: an allowed host, and an Origin on that same host. */
function sameOrigin(request: IncomingMessage): boolean {
  const host = request.headers.host ?? "";
  const origin = request.headers.origin;
  if (!allowedHosts.has(host) || !origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function send(socket: WebSocket, message: Message): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

async function bundleScripts(): Promise<Map<string, string>> {
  const result = await build({
    entryPoints: { app: join(here, "src/app.ts"), sandbox: join(here, "src/sandbox.ts") },
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
    outdir: "/",
    logLevel: "warning",
  });
  return new Map(result.outputFiles.map((file) => [basename(file.path), file.text]));
}
