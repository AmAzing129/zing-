import { join } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, StopReason, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";

export const TRANSCRIPT_VERSION = 1;

export type StoredText = { type: "text"; text: string };
export type StoredImage = { type: "image"; data: string; mimeType: string };
export type StoredThinking = { type: "thinking"; thinking: string };
export type StoredToolCall = { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

export type TranscriptEvent =
  | {
      v: typeof TRANSCRIPT_VERSION;
      type: "user";
      at: number;
      content: string | Array<StoredText | StoredImage>;
    }
  | {
      v: typeof TRANSCRIPT_VERSION;
      type: "assistant";
      at: number;
      model?: string;
      stopReason?: StopReason;
      errorMessage?: string;
      content: Array<StoredText | StoredThinking | StoredToolCall>;
    }
  | {
      v: typeof TRANSCRIPT_VERSION;
      type: "toolResult";
      at: number;
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content: Array<StoredText | StoredImage>;
      details?: unknown;
    }
  | {
      v: typeof TRANSCRIPT_VERSION;
      type: "reset";
      at: number;
    };

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function splitConversationId(conversationId: string): { channel: string; localId: string } {
  const cut = conversationId.indexOf(":");
  if (cut <= 0) {
    return { channel: "misc", localId: conversationId || "default" };
  }
  const channel = conversationId.slice(0, cut);
  const localId = conversationId.slice(cut + 1);
  return { channel, localId: localId || "default" };
}

export function conversationLogPath(capsulePath: string, conversationId: string): string {
  const { channel, localId } = splitConversationId(conversationId);
  return join(capsulePath, "conversations", safeSegment(channel), `${safeSegment(localId)}.jsonl`);
}

export function encodeMessages(messages: readonly AgentMessage[]): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  for (const message of messages) {
    const event = encodeMessage(message);
    if (event) {
      events.push(event);
    }
  }
  return events;
}

export function eventsAfterLastReset(events: readonly TranscriptEvent[]): TranscriptEvent[] {
  let lastReset = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === "reset") {
      lastReset = index;
      break;
    }
  }
  return lastReset === -1 ? [...events] : events.slice(lastReset + 1);
}

export function decodeEvents(events: readonly TranscriptEvent[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (const event of eventsAfterLastReset(events)) {
    messages.push(decodeEvent(event));
  }
  return messages;
}

export function parseTranscript(text: string, source: string): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  const lines = text.split("\n");
  const hasTerminatingNewline = text.endsWith("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === "") {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error) {
      if (!hasTerminatingNewline && index === lines.length - 1) {
        console.warn(`${source}:${index + 1}: ignoring incomplete final JSON line`);
        break;
      }
      throw new Error(`${source}:${index + 1}: invalid JSON`, { cause: error });
    }
    events.push(parseEvent(raw, `${source}:${index + 1}`));
  }
  return events;
}

export function formatEvents(events: readonly TranscriptEvent[]): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export function resetEvent(at = Date.now()): TranscriptEvent {
  return { v: TRANSCRIPT_VERSION, type: "reset", at };
}

function encodeMessage(message: AgentMessage): TranscriptEvent | undefined {
  if (message.role === "user") {
    return {
      v: TRANSCRIPT_VERSION,
      type: "user",
      at: message.timestamp,
      content: encodeUserContent(message.content),
    };
  }
  if (message.role === "assistant") {
    return {
      v: TRANSCRIPT_VERSION,
      type: "assistant",
      at: message.timestamp,
      model: message.model,
      stopReason: message.stopReason,
      errorMessage: message.errorMessage,
      content: encodeAssistantContent(message.content),
    };
  }
  if (message.role === "toolResult") {
    return {
      v: TRANSCRIPT_VERSION,
      type: "toolResult",
      at: message.timestamp,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
      content: encodeToolContent(message.content),
      details: message.details,
    };
  }
  return undefined;
}

function decodeEvent(event: TranscriptEvent): AgentMessage {
  if (event.type === "user") {
    return { role: "user", content: event.content, timestamp: event.at };
  }
  if (event.type === "assistant") {
    const message: AssistantMessage = {
      role: "assistant",
      content: event.content.map(decodeAssistantBlock),
      api: "unknown",
      provider: "unknown",
      model: event.model ?? "",
      usage: EMPTY_USAGE,
      stopReason: event.stopReason ?? "stop",
      errorMessage: event.errorMessage,
      timestamp: event.at,
    };
    return message;
  }
  if (event.type === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      content: event.content.map(decodeToolBlock),
      details: event.details,
      timestamp: event.at,
    };
  }
  throw new Error("reset events cannot be decoded into messages");
}

function encodeUserContent(content: string | (TextContent | ImageContent)[]): string | Array<StoredText | StoredImage> {
  if (typeof content === "string") {
    return content;
  }
  const blocks: Array<StoredText | StoredImage> = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks;
}

function encodeAssistantContent(content: AssistantMessage["content"]): Array<StoredText | StoredThinking | StoredToolCall> {
  const blocks: Array<StoredText | StoredThinking | StoredToolCall> = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      blocks.push({ type: "thinking", thinking: block.thinking });
    } else if (block.type === "toolCall") {
      blocks.push({
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      });
    }
  }
  return blocks;
}

function encodeToolContent(content: (TextContent | ImageContent)[]): Array<StoredText | StoredImage> {
  const blocks: Array<StoredText | StoredImage> = [];
  for (const block of content) {
    if (block.type === "text") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "image") {
      blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
    }
  }
  return blocks;
}

function decodeAssistantBlock(block: StoredText | StoredThinking | StoredToolCall): TextContent | ThinkingContent | ToolCall {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking };
  }
  return { type: "toolCall", id: block.id, name: block.name, arguments: block.arguments };
}

function decodeToolBlock(block: StoredText | StoredImage): TextContent | ImageContent {
  if (block.type === "text") {
    return { type: "text", text: block.text };
  }
  return { type: "image", data: block.data, mimeType: block.mimeType };
}

function parseEvent(raw: unknown, source: string): TranscriptEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: event must be a mapping`);
  }
  const record = raw as Record<string, unknown>;
  if (record.v !== TRANSCRIPT_VERSION) {
    throw new Error(`${source}: unsupported transcript version ${String(record.v)}`);
  }
  const type = record.type;
  const at = parseAt(record.at, source);
  if (type === "reset") {
    return { v: TRANSCRIPT_VERSION, type: "reset", at };
  }
  if (type === "user") {
    return { v: TRANSCRIPT_VERSION, type: "user", at, content: parseUserContent(record.content, source) };
  }
  if (type === "assistant") {
    return {
      v: TRANSCRIPT_VERSION,
      type: "assistant",
      at,
      model: optionalString(record.model),
      stopReason: optionalStopReason(record.stopReason),
      errorMessage: optionalString(record.errorMessage),
      content: parseAssistantContent(record.content, source),
    };
  }
  if (type === "toolResult") {
    return {
      v: TRANSCRIPT_VERSION,
      type: "toolResult",
      at,
      toolCallId: requiredString(record.toolCallId, `${source}: toolCallId`),
      toolName: requiredString(record.toolName, `${source}: toolName`),
      isError: Boolean(record.isError),
      content: parseToolContent(record.content, source),
      details: record.details,
    };
  }
  throw new Error(`${source}: unknown event type ${String(type)}`);
}

function parseUserContent(raw: unknown, source: string): string | Array<StoredText | StoredImage> {
  if (typeof raw === "string") {
    return raw;
  }
  return parseToolContent(raw, source);
}

function parseAssistantContent(raw: unknown, source: string): Array<StoredText | StoredThinking | StoredToolCall> {
  if (!Array.isArray(raw)) {
    throw new Error(`${source}: content must be an array`);
  }
  const blocks: Array<StoredText | StoredThinking | StoredToolCall> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new Error(`${source}: invalid content block`);
    }
    const block = item as Record<string, unknown>;
    if (block.type === "text") {
      blocks.push({ type: "text", text: requiredString(block.text, `${source}: text`) });
      continue;
    }
    if (block.type === "thinking") {
      blocks.push({ type: "thinking", thinking: requiredString(block.thinking, `${source}: thinking`) });
      continue;
    }
    if (block.type === "toolCall") {
      if (!block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) {
        throw new Error(`${source}: toolCall arguments must be a mapping`);
      }
      blocks.push({
        type: "toolCall",
        id: requiredString(block.id, `${source}: toolCall id`),
        name: requiredString(block.name, `${source}: toolCall name`),
        arguments: block.arguments as Record<string, unknown>,
      });
      continue;
    }
    throw new Error(`${source}: unknown assistant content type ${String(block.type)}`);
  }
  return blocks;
}

function parseToolContent(raw: unknown, source: string): Array<StoredText | StoredImage> {
  if (!Array.isArray(raw)) {
    throw new Error(`${source}: content must be an array`);
  }
  const blocks: Array<StoredText | StoredImage> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      throw new Error(`${source}: invalid content block`);
    }
    const block = item as Record<string, unknown>;
    if (block.type === "text") {
      blocks.push({ type: "text", text: requiredString(block.text, `${source}: text`) });
      continue;
    }
    if (block.type === "image") {
      blocks.push({
        type: "image",
        data: requiredString(block.data, `${source}: image data`),
        mimeType: requiredString(block.mimeType, `${source}: image mimeType`),
      });
      continue;
    }
    throw new Error(`${source}: unknown content type ${String(block.type)}`);
  }
  return blocks;
}

function parseAt(value: unknown, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${source}: at must be a number`);
  }
  return value;
}

function optionalStopReason(value: unknown): StopReason | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  return value as StopReason;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  return value;
}

function requiredString(value: unknown, source: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${source} is required`);
  }
  return value;
}

function safeSegment(value: string): string {
  if (value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value)) {
    return value;
  }
  if (value === ".") {
    return "%2E";
  }
  if (value === "..") {
    return "%2E%2E";
  }
  return encodeURIComponent(value) || "x";
}
