/**
 * The chat page: a Zing App Server client that also hosts MCP Apps. Text, tool calls, and approvals come from the
 * protocol; a tool whose MCP definition names a ui:// view gets that view, rendered in the sandbox on another origin.
 */
import {
  AppBridge,
  buildAllowAttribute,
  getToolUiResourceUri,
  PostMessageTransport,
  RESOURCE_MIME_TYPE,
  type McpUiResourceCsp,
  type McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult, ReadResourceResult, Tool } from "@modelcontextprotocol/client";

type Params = Record<string, unknown>;
type Entry =
  | { type: "user"; content: string | Array<{ type: string; text?: string }> }
  | { type: "assistant"; content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: Params }> }
  | { type: "toolResult"; toolCallId: string; isError: boolean; details?: unknown };
/** A tool with a view: the MCP server to ask and the tool's definition. */
type App = { server: string; tool: Tool; uri: string };

const HOST = { name: "zing-web-example", version: "0.1.0" };
const THREAD_KEY = "zing.threadId";

const log = element("log");
const composer = element("composer") as HTMLFormElement;
const input = element("input") as HTMLTextAreaElement;
const send = element("send") as HTMLButtonElement;
const stop = element("stop") as HTMLButtonElement;
const status = element("status");

class Rpc {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  #nextId = 1;
  onNotification: (method: string, params: Params) => void = () => {};

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Params;
        result?: unknown;
        error?: { message: string };
      };
      if (message.method) return this.onNotification(message.method, message.params ?? {});
      const call = this.#pending.get(message.id ?? -1);
      this.#pending.delete(message.id ?? -1);
      if (message.error) call?.reject(new Error(message.error.message));
      else call?.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      status.textContent = "连接已断开，刷新页面重连";
      for (const call of this.#pending.values()) call.reject(new Error("disconnected"));
      this.#pending.clear();
    });
  }

  static connect(): Promise<Rpc> {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`);
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve(new Rpc(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error("cannot connect")), { once: true });
    });
  }

  call<T>(method: string, params: unknown = {}): Promise<T> {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
    });
  }
}

/** Which Zing tools have a view, from the MCP plugin's methods, when the station has them. */
async function loadApps(methods: readonly string[]): Promise<Map<string, App>> {
  const found = new Map<string, App>();
  if (!methods.includes("mcp/servers/list")) return found;
  const { servers } = await rpc.call<{
    servers: Array<{ server: string; tools: Array<{ definition: Tool; zingTool?: string }> }>;
  }>("mcp/servers/list");
  for (const { server, tools } of servers) {
    for (const { definition, zingTool } of tools) {
      const uri = getToolUiResourceUri(definition);
      if (zingTool && uri) found.set(zingTool, { server, tool: definition, uri });
    }
  }
  return found;
}

async function openThread(requested: string | undefined): Promise<string> {
  const { thread } = await rpc.call<{ thread: { threadId: string } }>("thread/open", requested ? { threadId: requested } : {});
  localStorage.setItem(THREAD_KEY, thread.threadId);
  return thread.threadId;
}

/** Replay the thread, views included: a view gets the call's arguments and the result's details. */
async function renderHistory(): Promise<void> {
  const { thread } = await rpc.call<{ thread: { entries: Entry[] } }>("thread/read", { threadId });
  for (const entry of thread.entries) {
    if (entry.type === "user") {
      const text = typeof entry.content === "string" ? entry.content : textOf(entry.content);
      add("div", "user", text);
    } else if (entry.type === "assistant") {
      const text = textOf(entry.content);
      if (text) add("div", "assistant", text);
      for (const block of entry.content) {
        if (block.type === "toolCall") toolStarted(String(block.id), String(block.name), block.arguments ?? {});
      }
    } else if (entry.type === "toolResult") {
      toolCompleted(entry.toolCallId, entry.isError, entry.details);
    }
  }
}

async function startTurn(text: string): Promise<void> {
  add("div", "user", text);
  try {
    const { turn } = await rpc.call<{ turn: { id: string } }>("turn/start", { threadId, input: { type: "text", text } });
    turns.add(turn.id);
    setIdle();
  } catch (error) {
    add("div", "error", `没有发出去：${(error as Error).message}`);
  }
}

function turnCompleted(params: Params): void {
  const turnId = String(params.turnId);
  turns.delete(turnId);
  for (const card of approvals.get(turnId) ?? []) retire(card, "已失效：这轮对话已结束。");
  approvals.delete(turnId);
  if (params.status === "failed") add("div", "error", `出错了：${(params.error as { message?: string })?.message ?? ""}`);
  if (params.status === "canceled") add("div", "tool", "已停止");
  setIdle();
}

function toolStarted(callId: string, name: string, args: Params): void {
  const line = add("div", "tool", `调用 ${name}…`);
  const app = apps.get(name);
  const view = app ? new AppView(app, args) : undefined;
  if (view) log.append(view.card);
  calls.set(callId, { line, ...(view ? { view } : {}) });
}

function toolCompleted(callId: string, isError: boolean, details: unknown): void {
  const call = calls.get(callId);
  if (!call) return;
  call.line.textContent = call.line.textContent.replace(/…$/, isError ? " 失败" : " ✓");
  call.line.classList.toggle("error", isError);
  if (!call.view) return;
  // The MCP plugin's details are the tool's whole CallToolResult.
  if (isError || !isRecord(details)) call.view.cancel(isError ? "工具调用失败" : "没有结果");
  else call.view.result(details as CallToolResult);
}

function askApproval(params: Params): void {
  const turnId = String(params.turnId);
  const card = add("div", "card");
  const body = document.createElement("div");
  body.className = "approval";
  const title = document.createElement("strong");
  title.textContent = `需要你确认才会执行：${String(params.tool)}`;
  const description = document.createElement("div");
  description.className = "tool";
  description.textContent = String(params.description ?? "");
  const shown = document.createElement("pre");
  shown.textContent = JSON.stringify(params.input, null, 2);
  const actions = document.createElement("div");
  actions.className = "actions";
  const answer = (approved: boolean) => {
    approvals.get(turnId)?.delete(card);
    retire(card, approved ? "已允许。" : "已拒绝。");
    void rpc.call("approval/respond", { approvalId: params.approvalId, approved }).catch(() => undefined);
  };
  for (const [label, approved] of [["允许", true], ["拒绝", false]] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (approved) button.className = "primary";
    button.addEventListener("click", () => answer(approved));
    actions.append(button);
  }
  body.append(title, description, shown, actions);
  card.append(body);
  approvals.set(turnId, (approvals.get(turnId) ?? new Set()).add(card));
}

function retire(card: HTMLElement, note: string): void {
  const actions = card.querySelector(".actions");
  if (!actions) return;
  const done = document.createElement("div");
  done.className = "tool";
  done.textContent = note;
  actions.replaceWith(done);
}

/** One rendered view: its sandbox frame, and the bridge that speaks MCP Apps with it. */
class AppView {
  readonly card = document.createElement("div");
  readonly #app: App;
  /** Input, then result, in order, once the view has initialized. */
  #queue: Promise<AppBridge | undefined>;

  constructor(app: App, args: Params) {
    this.#app = app;
    this.card.className = "card";
    this.#queue = this.#open().catch((error: unknown) => {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = `界面没有加载：${(error as Error).message}`;
      this.card.replaceChildren(note);
      return undefined;
    });
    this.#then((bridge) => bridge.sendToolInput({ arguments: args }));
  }

  result(result: CallToolResult): void {
    this.#then((bridge) => bridge.sendToolResult(result));
  }

  cancel(reason: string): void {
    this.#then((bridge) => bridge.sendToolCancelled({ reason }));
  }

  #then(step: (bridge: AppBridge) => Promise<void>): void {
    this.#queue = this.#queue.then(async (bridge) => {
      if (bridge) await step(bridge).catch((error: unknown) => console.warn("MCP App", error));
      return bridge;
    });
  }

  async #open(): Promise<AppBridge> {
    const { server, uri, tool } = this.#app;
    const resource = await rpc.call<ReadResourceResult>("mcp/resources/read", { server, uri });
    const content = resource.contents.find((item) => item.uri === uri) ?? resource.contents[0];
    if (!content || content.mimeType !== RESOURCE_MIME_TYPE) throw new Error(`${uri} 不是 MCP App`);
    const html = "text" in content ? content.text : new TextDecoder().decode(base64(content.blob));
    const ui = (content._meta?.ui ?? {}) as { csp?: McpUiResourceCsp; permissions?: McpUiResourcePermissions };

    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
    const allow = buildAllowAttribute(ui.permissions);
    if (allow) frame.setAttribute("allow", allow);
    const url = new URL(config.sandboxUrl);
    if (ui.csp) url.searchParams.set("csp", JSON.stringify(ui.csp));
    const proxyReady = new Promise<void>((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return;
        if ((event.data as { method?: string })?.method !== "ui/notifications/sandbox-proxy-ready") return;
        window.removeEventListener("message", listener);
        resolve();
      };
      window.addEventListener("message", listener);
    });
    frame.src = url.href;
    this.card.append(frame);
    await proxyReady;

    const bridge = new AppBridge(
      null,
      HOST,
      { openLinks: {}, serverTools: {}, serverResources: {}, message: { text: {} }, logging: {} },
      {
        hostContext: {
          toolInfo: { tool },
          theme: "light",
          platform: "web",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          containerDimensions: { maxHeight: 6000 },
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      },
    );
    // The view reaches only its own server, through the station.
    bridge.oncalltool = (params) =>
      rpc.call<CallToolResult>("mcp/tools/call", { server, name: params.name, arguments: params.arguments ?? {} });
    bridge.onreadresource = (params) => rpc.call<ReadResourceResult>("mcp/resources/read", { server, uri: params.uri });
    bridge.onmessage = async (params) => {
      const text = textOf(params.content);
      if (!text) return { isError: true };
      void startTurn(text);
      return {};
    };
    bridge.onopenlink = async ({ url: link }) => {
      if (/^https?:/i.test(link)) window.open(link, "_blank", "noopener,noreferrer");
      return {};
    };
    bridge.onsizechange = ({ height }) => {
      if (height !== undefined) frame.style.height = `${Math.ceil(height)}px`;
    };
    const ready = new Promise<void>((resolve) => {
      bridge.oninitialized = () => resolve();
    });
    await bridge.connect(new PostMessageTransport(frame.contentWindow!, frame.contentWindow!));
    await bridge.sendSandboxResourceReady({ html, csp: ui.csp, permissions: ui.permissions });
    await ready;
    return bridge;
  }
}

function bubble(messageId: string): HTMLElement {
  let found = bubbles.get(messageId);
  if (!found) {
    found = add("div", "assistant", "");
    bubbles.set(messageId, found);
  }
  return found;
}

function add(tag: string, className: string, text = ""): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  log.append(node);
  node.scrollIntoView({ block: "end" });
  return node;
}

function setIdle(): void {
  const busy = turns.size > 0;
  input.disabled = false;
  send.disabled = false;
  stop.hidden = !busy;
  if (!busy) input.focus();
}

function textOf(blocks: ReadonlyArray<{ type: string; text?: string }>): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function base64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function isRecord(value: unknown): value is Params {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing #${id}`);
  return found;
}

// Startup comes last: the history replay below uses the classes and functions above.
const config = (await (await fetch("/config.json")).json()) as { sandboxUrl: string };
const rpc = await Rpc.connect();
const initialized = await rpc.call<{ agent: { name: string }; capabilities: { methods?: string[] } }>("initialize", {
  protocolVersion: 1,
  clientInfo: HOST,
  capabilities: { approvals: true },
});
element("agent").textContent = initialized.agent.name;
const apps = await loadApps(initialized.capabilities.methods ?? []);

let threadId = await openThread(localStorage.getItem(THREAD_KEY) ?? undefined);
const turns = new Set<string>();
/** Per tool call: its status line, and its view when the tool has one. */
const calls = new Map<string, { line: HTMLElement; view?: AppView }>();
const bubbles = new Map<string, HTMLElement>();
/** Approvals still waiting, by turn, so the turn's end can retire them. */
const approvals = new Map<string, Set<HTMLElement>>();

rpc.onNotification = (method, params) => {
  if (method === "message/delta") bubble(String(params.messageId)).textContent += String(params.delta);
  else if (method === "message/completed") bubble(String(params.messageId)).textContent = String(params.text);
  else if (method === "tool/started") toolStarted(String(params.callId), String(params.name), (params.input ?? {}) as Params);
  else if (method === "tool/completed") toolCompleted(String(params.callId), params.isError === true, params.details);
  else if (method === "approval/requested") askApproval(params);
  else if (method === "turn/completed") turnCompleted(params);
};

await renderHistory();
status.textContent = apps.size > 0 ? `${apps.size} 个工具带界面` : "";
setIdle();

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  void startTurn(text);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
});
stop.addEventListener("click", () => {
  for (const turnId of turns) void rpc.call("turn/cancel", { threadId, turnId }).catch(() => undefined);
});
element("new-thread").addEventListener("click", async () => {
  localStorage.removeItem(THREAD_KEY);
  threadId = await openThread(undefined);
  log.replaceChildren();
});
