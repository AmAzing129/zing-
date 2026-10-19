import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Trigger, ZingPluginAPI } from "zing";

export const WEBHOOK_SOURCE_ID = "webhook";
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_TEXT_CHARS = 16_000;
const HOOK_PATH = /^\/hooks\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;

export type WebhookOptions = {
  token: string;
  host?: string;
  port?: number;
  /** Conversation used when a request does not name one with ?conversation=. */
  defaultConversation?: string;
  dispatch: (trigger: Trigger) => Promise<unknown>;
  onListening?: (address: AddressInfo) => void;
};

/**
 * POST /hooks/<name> fires a webhook trigger. The request is accepted with 202 before the turn runs;
 * the reply goes to the conversation's remembered route.
 */
export async function runWebhookServer(options: WebhookOptions, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const token = Buffer.from(options.token);
  const inFlight = new Set<Promise<void>>();

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error("webhook request failed", error);
      if (!response.headersSent) reply(response, 500, { error: "internal error" });
    });
  });

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://webhook.local");
    const match = HOOK_PATH.exec(url.pathname);
    if (!match?.[1]) {
      reply(response, 404, { error: "not found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      reply(response, 405, { error: "method not allowed" });
      return;
    }
    if (!authorized(request, url, token)) {
      reply(response, 401, { error: "unauthorized" });
      return;
    }
    const conversationId = url.searchParams.get("conversation")?.trim() || options.defaultConversation;
    if (!conversationId) {
      reply(response, 400, { error: "no conversation: pass ?conversation= or set ZING_WEBHOOK_CONVERSATION" });
      return;
    }
    const body = await readBody(request);
    if (body === undefined) {
      reply(response, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` });
      return;
    }
    const text = triggerText(body, request.headers["content-type"]);
    if (!text) {
      reply(response, 400, { error: "empty body" });
      return;
    }
    // Reject rather than truncate: an accepted request always reaches the agent whole.
    if (text.length > MAX_TEXT_CHARS) {
      reply(response, 413, { error: `trigger text exceeds ${MAX_TEXT_CHARS} characters` });
      return;
    }

    const work = options
      .dispatch({ kind: "webhook", source: `webhook:${match[1]}`, conversationId, text, deliver: "conversation" })
      .then(
        () => undefined,
        (error: unknown) => console.error(`webhook ${match[1]} turn failed`, error),
      );
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
    reply(response, 202, { accepted: true });
  };

  await listen(server, options.host ?? "127.0.0.1", options.port ?? 8787);
  options.onListening?.(server.address() as AddressInfo);

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([...inFlight]);
}

export default function webhookPlugin(zing: ZingPluginAPI) {
  zing.registerTriggerSource({
    id: WEBHOOK_SOURCE_ID,
    start: (signal) =>
      runWebhookServer(
        {
          token: zing.requireEnv("ZING_WEBHOOK_TOKEN"),
          host: zing.env.ZING_WEBHOOK_HOST?.trim() || undefined,
          port: parsePort(zing.env.ZING_WEBHOOK_PORT),
          defaultConversation: zing.env.ZING_WEBHOOK_CONVERSATION?.trim() || undefined,
          dispatch: (trigger) => zing.host.dispatch(trigger),
          onListening: (address) => console.log(`Webhook trigger listening on ${address.address}:${address.port}`),
        },
        signal,
      ),
  });
}

/** A JSON body with a string `text` field uses that text; any other body is passed through verbatim. */
export function triggerText(body: string, contentType: string | undefined): string {
  if (contentType?.includes("json")) {
    try {
      const parsed = JSON.parse(body) as unknown;
      if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
        return (parsed as { text: string }).text.trim();
      }
    } catch {
      // Not JSON after all; fall through to the raw body.
    }
  }
  return body.trim();
}

function authorized(request: IncomingMessage, url: URL, token: Buffer): boolean {
  const header = request.headers.authorization;
  const bearer = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
  const presented = bearer ?? url.searchParams.get("token") ?? "";
  const candidate = Buffer.from(presented);
  return candidate.length === token.length && timingSafeEqual(candidate, token);
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      return undefined;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function parsePort(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`ZING_WEBHOOK_PORT must be a port number, got ${trimmed}`);
  }
  return port;
}
