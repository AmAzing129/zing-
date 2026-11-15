import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ConversationEvent, ThreadEntry, TurnContext } from "zing";

export const TRAJECTORY_VERSION = 1 as const;

/** One line of a trajectory file: a persisted turn, with what the model was given, or a reset. */
export type TrajectoryRecord =
  | {
      v: typeof TRAJECTORY_VERSION;
      type: "turn";
      recordedAt: number;
      agentId: string;
      conversationId: string;
      senderId?: string;
      status: "completed" | "failed" | "canceled";
      context: TurnContext;
      entries: ThreadEntry[];
    }
  | { v: typeof TRAJECTORY_VERSION; type: "reset"; recordedAt: number; agentId: string; conversationId: string };

export function trajectoryDir(env: NodeJS.ProcessEnv): string {
  const home = env.ZING_HOME?.trim() || join(homedir(), ".zing");
  return env.ZING_TRAJECTORY_DIR?.trim() || join(home, "trajectories");
}

export function toRecord(event: ConversationEvent, recordedAt = Date.now()): TrajectoryRecord {
  const base = { v: TRAJECTORY_VERSION, recordedAt, agentId: event.capsule.agentId, conversationId: event.conversationId };
  if (event.type === "reset") return { ...base, type: "reset" };
  return {
    ...base,
    type: "turn",
    ...(event.senderId === undefined ? {} : { senderId: event.senderId }),
    status: event.status,
    context: event.context,
    entries: event.entries,
  };
}

/** Appends a record to its UTC month's file, e.g. 2026-11.jsonl. Transcripts are private: owner-only modes. */
export async function appendRecord(dir: string, record: TrajectoryRecord): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${new Date(record.recordedAt).toISOString().slice(0, 7)}.jsonl`);
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };
export type ChatTool = { type: "function"; function: { name: string; description: string; parameters: unknown } };
/** One training example in the OpenAI chat fine-tuning shape. */
export type ChatSample = { messages: ChatMessage[]; tools?: ChatTool[] };

export type ExportStats = { turns: number; skipped: number; duplicates: number; samples: number };

/**
 * Builds one sample per uninterrupted stretch of a conversation: completed turns under the same context, ended by a
 * reset, a failed or canceled turn (dropped, since later turns no longer follow from it), or a context change.
 * Thinking is dropped: providers return summaries or encrypted reasoning, not a trainable trace.
 */
export function toSamples(records: Iterable<TrajectoryRecord>): { samples: ChatSample[]; stats: ExportStats } {
  const samples: ChatSample[] = [];
  const stats: ExportStats = { turns: 0, skipped: 0, duplicates: 0, samples: 0 };
  const open = new Map<string, { key: string; context: TurnContext; messages: ChatMessage[] }>();
  /** Turn identities per conversation since its last reset: a reset starts a new stretch. */
  const seen = new Map<string, Set<string>>();

  const flush = (conversation: string) => {
    const segment = open.get(conversation);
    open.delete(conversation);
    if (!segment?.messages.some((message) => message.role === "assistant")) return;
    const tools = segment.context.tools.map(({ name, description, parameters }): ChatTool => ({
      type: "function",
      function: { name, description, parameters },
    }));
    samples.push({
      messages: [{ role: "system", content: segment.context.system }, ...segment.messages],
      ...(tools.length > 0 ? { tools } : {}),
    });
  };

  for (const record of records) {
    const conversation = `${record.agentId}\u0000${record.conversationId}`;
    if (record.type === "reset") {
      flush(conversation);
      seen.delete(conversation);
      continue;
    }
    // A durable station that stops between writing a turn and acknowledging it observes that turn again, at another
    // time and possibly under a changed context; its entries are what make it the same turn.
    const identity = createHash("sha256").update(JSON.stringify(record.entries)).digest("hex");
    const stretch = seen.get(conversation) ?? new Set<string>();
    seen.set(conversation, stretch);
    if (stretch.has(identity)) {
      stats.duplicates++;
      continue;
    }
    stretch.add(identity);
    stats.turns++;
    if (record.status !== "completed") {
      stats.skipped++;
      flush(conversation);
      continue;
    }
    const key = JSON.stringify(record.context);
    if (open.get(conversation)?.key !== key) flush(conversation);
    const segment = open.get(conversation) ?? { key, context: record.context, messages: [] };
    open.set(conversation, segment);
    segment.messages.push(...record.entries.flatMap(toChatMessages));
  }
  for (const conversation of [...open.keys()]) flush(conversation);
  stats.samples = samples.length;
  return { samples, stats };
}

function toChatMessages(entry: ThreadEntry): ChatMessage[] {
  if (entry.type === "user") {
    if (typeof entry.content === "string") return [{ role: "user", content: entry.content }];
    return [{
      role: "user",
      content: entry.content.map((part): ContentPart =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } },
      ),
    }];
  }
  if (entry.type === "toolResult") {
    const text = entry.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
    return [{ role: "tool", tool_call_id: entry.toolCallId, content: text }];
  }
  const text = entry.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  const calls = entry.content.flatMap((part) =>
    part.type === "toolCall"
      ? [{ id: part.id, type: "function" as const, function: { name: part.name, arguments: JSON.stringify(part.arguments) } }]
      : [],
  );
  if (!text && calls.length === 0) return [];
  return [{ role: "assistant", content: text || null, ...(calls.length > 0 ? { tool_calls: calls } : {}) }];
}
