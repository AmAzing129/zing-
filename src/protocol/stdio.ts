import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import type { AgentRuntime } from "../runtime";
import { ProtocolSession } from "./server";
import type { AppServerInfo, JsonRpcMessage } from "./types";

export type StdioAppServerOptions = {
  input?: Readable;
  output?: Writable;
  signal?: AbortSignal;
  onError?: (error: unknown) => void;
};

export async function runStdioAppServer(
  runtime: AgentRuntime,
  info: AppServerInfo,
  options: StdioAppServerOptions = {},
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const onError = options.onError ?? ((error: unknown) => console.error("app-server error", error));
  const session = new ProtocolSession({
    runtime,
    info,
    write: (message) => writeMessage(output, message),
    onError,
  });
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Infinity });
  const abort = () => lines.close();
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    const closed = new Promise<void>((resolve, reject) => {
      lines.on("line", (line) => {
        const handling = session.handleLine(line).catch(onError);
        pending.add(handling);
        void handling.finally(() => pending.delete(handling));
      });
      lines.once("close", resolve);
      input.once("error", reject);
    });
    if (options.signal?.aborted) {
      lines.close();
    }
    await closed;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await Promise.allSettled([...pending]);
    await session.close();
  }
}

function writeMessage(output: Writable, message: JsonRpcMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    output.write(`${JSON.stringify(message)}\n`, "utf8", (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
