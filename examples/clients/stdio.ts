import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const prompt = process.argv.slice(2).join(" ").trim() || "你好，请介绍一下自己";
const server = spawn(
  "./node_modules/.bin/tsx",
  ["src/index.ts", "app-server"],
  { stdio: ["pipe", "pipe", "inherit"] },
);
const lines = createInterface({ input: server.stdout });
let threadId: string | undefined;

function send(id: number, method: string, params: unknown): void {
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line) as unknown;
  if (!isRecord(message)) {
    return;
  }
  if (message.id === 2 && isRecord(message.result) && isRecord(message.result.thread)) {
    const opened = message.result.thread.threadId;
    if (typeof opened === "string") {
      threadId = opened;
      send(3, "turn/start", { threadId, input: { type: "text", text: prompt } });
    }
    return;
  }
  if (message.method === "message/delta" && isRecord(message.params)) {
    const delta = message.params.delta;
    if (typeof delta === "string") {
      process.stdout.write(delta);
    }
    return;
  }
  if (message.method === "turn/completed" && isRecord(message.params)) {
    process.stdout.write("\n");
    server.stdin.end();
  }
});

server.once("exit", (code) => {
  if (code !== 0) {
    process.exitCode = code ?? 1;
  }
});

send(1, "initialize", {
  protocolVersion: 1,
  clientInfo: { name: "zing-stdio-example", version: "0.1.0" },
});
send(2, "thread/open", {});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
