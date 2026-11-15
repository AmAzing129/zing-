import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import type { ThreadSnapshot } from "../../src/runtime";
import { SCRIPTED_MODEL_ID, type ModelRequest, type Script } from "./fixtures/scripted-model";
import type { ToolLogEntry } from "./fixtures/test-tools";

export type { ModelRequest, Script, ToolLogEntry };

const REPO = resolve(import.meta.dirname, "../..");
// The tsx loader, not its CLI: the CLI runs the script in a grandchild, which a SIGKILL sent to the child would miss.
const TSX_LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const ENTRY = join(REPO, "src/index.ts");
const FIXTURES = join(import.meta.dirname, "fixtures");
const WAIT_MS = 15_000;

export type StationOptions = {
  script: Script;
  /** The blueprint's tool allowlist. */
  tools: string[];
  /** Repository plugins to enable besides the scripted model and test tools, such as "plugins/tools/notes". */
  plugins?: string[];
  limits?: { turnTimeoutMs?: number; maxModelTurns?: number; maxToolCalls?: number };
  /** Skill name to SKILL.md contents; each is written to skills/<name> and listed in the blueprint. */
  skills?: Record<string, string>;
  runtime?: "legacy" | "durable";
};

export type TurnCompleted = {
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "canceled";
  result?: { text: string };
  error?: { message: string };
};

export type Notification = { method: string; params: Record<string, unknown> & { turnId?: string } };

/**
 * A station in a temporary ZING_HOME: blueprint, station config, and the scripted model's script. Every process it
 * starts runs the real entry point with a minimal environment and is killed, with the directory removed, after the test.
 */
export async function createStation(t: TestContext, options: StationOptions): Promise<Station> {
  const root = await mkdtemp(join(tmpdir(), "zing-e2e-"));
  const station = new Station(root);
  t.after(() => station.dispose());

  const skills = Object.entries(options.skills ?? {});
  for (const [name, contents] of skills) {
    await mkdir(join(root, "skills", name), { recursive: true });
    await writeFile(join(root, "skills", name, "SKILL.md"), contents);
  }
  const blueprint = {
    name: "e2e",
    model: SCRIPTED_MODEL_ID,
    system: "You are the end-to-end test agent.",
    tools: options.tools,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(skills.length ? { skills: skills.map(([name]) => `./skills/${name}`) } : {}),
  };
  const plugins = [
    join(FIXTURES, "scripted-model.ts"),
    join(FIXTURES, "test-tools.ts"),
    ...(options.plugins ?? []).map((path) => join(REPO, path)),
  ];
  // JSON is valid YAML, so there is no quoting to get wrong.
  await writeFile(join(root, "agent.yaml"), JSON.stringify(blueprint, null, 2));
  await writeFile(
    join(root, "station.yaml"),
    JSON.stringify({ plugins, runtime: options.runtime ?? "legacy" }, null, 2),
  );
  await writeFile(join(root, "script.json"), JSON.stringify(options.script));
  await writeFile(join(root, "model.jsonl"), "");
  await writeFile(join(root, "tools.jsonl"), "");
  return station;
}

export class Station {
  readonly home: string;
  private readonly processes = new Set<ChildProcessWithoutNullStreams>();

  constructor(readonly root: string) {
    this.home = join(root, "home");
  }

  /** Start `zing app-server` and complete the initialize handshake. */
  async start(): Promise<AppServer> {
    const server = new AppServer(this.spawn(["app-server"]));
    await server.initialize();
    return server;
  }

  /** Run `zing --once <text>` to completion. */
  async once(text: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = this.spawn(["--once", text]);
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    const { code } = await exited(child, WAIT_MS, () => stderr);
    return { code, stdout, stderr };
  }

  /** Every request the scripted model received, oldest first; optionally only those for one user text. */
  async modelRequests(prompt?: string): Promise<ModelRequest[]> {
    const requests = await readJsonLines<ModelRequest>(join(this.root, "model.jsonl"));
    return prompt === undefined ? requests : requests.filter((request) => request.prompt === prompt);
  }

  /** Every recorded test-tool execution event, oldest first. */
  async toolLog(): Promise<ToolLogEntry[]> {
    return readJsonLines<ToolLogEntry>(join(this.root, "tools.jsonl"));
  }

  /** The concatenated contents of every file in the capsule, for checking what storage retains. */
  async capsuleContents(): Promise<string> {
    const files = await readdir(join(this.home, "capsules"), { recursive: true, withFileTypes: true });
    const contents = await Promise.all(
      files.filter((file) => file.isFile()).map((file) => readFile(join(file.parentPath, file.name), "utf8")),
    );
    return contents.join("\n");
  }

  async dispose(): Promise<void> {
    for (const child of this.processes) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise((done) => child.once("exit", done));
      }
    }
    await rm(this.root, { recursive: true, force: true });
  }

  private spawn(args: string[]): ChildProcessWithoutNullStreams {
    const child = spawn(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        ENTRY,
        "--station",
        join(this.root, "station.yaml"),
        "--blueprint",
        join(this.root, "agent.yaml"),
        // Last: --once takes the rest of the arguments as its message.
        ...args,
      ],
      {
        // Outside the repository and with a minimal environment, so neither a developer's .env (loaded from the
        // working directory) nor variables such as XAI_API_KEY, ZING_PLUGINS, or MODEL leak into the station.
        cwd: this.root,
        env: {
          PATH: process.env.PATH,
          ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
          HOME: this.root,
          TSX_TSCONFIG_PATH: join(REPO, "tsconfig.json"),
          ZING_HOME: this.home,
          ZING_E2E_SCRIPT: join(this.root, "script.json"),
          ZING_E2E_MODEL_LOG: join(this.root, "model.jsonl"),
          ZING_E2E_TOOL_LOG: join(this.root, "tools.jsonl"),
        },
      },
    );
    this.processes.add(child);
    return child;
  }
}

/** A JSON-RPC client over one `zing app-server` process's stdio. */
export class AppServer {
  agent!: { agentId: string; name: string; modelId: string };
  readonly notifications: Notification[] = [];
  private stderr = "";
  private readonly nonProtocolLines: string[] = [];
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<() => void>();
  private nextId = 1;
  private readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (this.stderr += chunk));
    createInterface({ input: child.stdout }).on("line", (line) => this.receive(line));
    this.exit = new Promise((done) => {
      child.once("exit", (code, signal) => {
        for (const { reject } of this.pending.values()) {
          reject(new Error(`app-server exited (code=${code} signal=${signal}) before replying\n${this.stderr}`));
        }
        this.pending.clear();
        done({ code, signal });
      });
    });
  }

  async initialize(): Promise<void> {
    const result = await this.request<{ agent: AppServer["agent"] }>("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "zing-e2e", version: "0" },
    });
    this.agent = result.agent;
  }

  /** Send a request; resolves with its result and rejects with its error, so a mistaken call fails fast. */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return withTimeout(
      new Promise<T>((resolveResult, reject) => {
        this.pending.set(id, { resolve: resolveResult as (value: unknown) => void, reject });
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
      `${method} response`,
      () => this.stderr,
    );
  }

  async startTurn(threadId: string, text: string): Promise<{ turnId: string; status: string }> {
    const result = await this.request<{ turn: { id: string; status: string } }>("turn/start", {
      threadId,
      input: { type: "text", text },
    });
    return { turnId: result.turn.id, status: result.turn.status };
  }

  /** Start a turn and wait for its terminal event. */
  async runTurn(threadId: string, text: string): Promise<TurnCompleted & { events: Notification[] }> {
    const { turnId } = await this.startTurn(threadId, text);
    const completed = await this.completion(turnId);
    return { ...completed, events: this.events(turnId) };
  }

  async completion(turnId: string): Promise<TurnCompleted> {
    const notification = await this.waitFor(
      (n) => n.method === "turn/completed" && n.params.turnId === turnId,
      `turn/completed for ${turnId}`,
    );
    return notification.params as TurnCompleted;
  }

  /** Every notification for one turn, in arrival order. */
  events(turnId: string): Notification[] {
    return this.notifications.filter((n) => n.params.turnId === turnId);
  }

  async readThread(threadId: string): Promise<ThreadSnapshot> {
    return (await this.request<{ thread: ThreadSnapshot }>("thread/read", { threadId })).thread;
  }

  waitFor(predicate: (notification: Notification) => boolean, description: string): Promise<Notification> {
    const found = this.notifications.find(predicate);
    if (found) return Promise.resolve(found);
    let stop = () => {};
    const waiting = new Promise<Notification>((resolveFound, reject) => {
      const check = () => {
        const match = this.notifications.find(predicate);
        if (match) resolveFound(match);
      };
      this.listeners.add(check);
      void this.exit.then(({ code, signal }) =>
        reject(new Error(`app-server exited (code=${code} signal=${signal}) before ${description}\n${this.stderr}`)),
      );
      stop = () => this.listeners.delete(check);
    });
    return withTimeout(waiting, description, () => this.stderr).finally(stop);
  }

  /** End stdin, as a client disconnecting does, and wait for the process to exit. */
  async close(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.child.stdin.end();
    return this.exited();
  }

  async kill(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    this.child.kill(signal);
    return this.exited();
  }

  private async exited() {
    const result = await withTimeout(this.exit, "app-server exit", () => this.stderr);
    if (this.nonProtocolLines.length > 0) {
      throw new Error(`stdout carried non-protocol output:\n${this.nonProtocolLines.join("\n")}`);
    }
    return result;
  }

  private receive(line: string): void {
    let message: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      this.nonProtocolLines.push(line);
      return;
    }
    if (message.jsonrpc !== "2.0") {
      this.nonProtocolLines.push(line);
      return;
    }
    if (typeof message.method === "string") {
      this.notifications.push({ method: message.method, params: (message.params ?? {}) as Notification["params"] });
      for (const listener of this.listeners) listener();
      return;
    }
    const waiter = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!waiter) {
      this.nonProtocolLines.push(line);
      return;
    }
    this.pending.delete(message.id as number);
    if (message.error) {
      const error = message.error as { code: number; message: string };
      waiter.reject(Object.assign(new Error(`JSON-RPC error ${error.code}: ${error.message}`), { code: error.code }));
    } else {
      waiter.resolve(message.result);
    }
  }
}

/** The text of each user and assistant entry that has any, in order: what was said, without tool traffic. */
export function spokenTexts(thread: ThreadSnapshot): string[] {
  return thread.entries.flatMap((entry) => {
    if (entry.type === "toolResult") return [];
    const blocks = typeof entry.content === "string" ? [{ type: "text", text: entry.content }] : entry.content;
    const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    return text ? [text] : [];
  });
}

/** Concatenate a turn's message/delta notifications per message, for comparison with message/completed. */
export function streamedText(events: Notification[]): Map<string, string> {
  const text = new Map<string, string>();
  for (const event of events) {
    if (event.method === "message/delta") {
      const id = String(event.params.messageId);
      text.set(id, (text.get(id) ?? "") + String(event.params.delta));
    }
  }
  return text;
}

async function readJsonLines<T>(path: string): Promise<T[]> {
  const contents = await readFile(path, "utf8");
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function exited(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  stderr: () => string,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return withTimeout(
    new Promise((done) => child.once("exit", (code, signal) => done({ code, signal }))),
    "process exit",
    stderr,
    timeoutMs,
  );
}

function withTimeout<T>(promise: Promise<T>, description: string, stderr: () => string, timeoutMs = WAIT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}\n--- stderr ---\n${stderr()}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
