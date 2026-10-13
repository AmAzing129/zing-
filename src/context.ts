import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, UserMessage } from "@earendil-works/pi-ai";
import { estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";

export const CONTEXT_OMISSION_TEXT =
  "Earlier complete conversation turns were omitted to fit the model context window.";

const MAX_OUTPUT_RESERVE_TOKENS = 16_384;
const MIN_OUTPUT_RESERVE_TOKENS = 64;
const MAX_SAFETY_MARGIN_TOKENS = 2_048;
const MIN_SAFETY_MARGIN_TOKENS = 32;

export type ContextWindowPolicy = {
  messageBudget: number;
  fit: <T extends AgentMessage>(messages: T[]) => T[];
  currentTurnFits: (messages: AgentMessage[]) => boolean;
  userInputFits: (text: string, hasHistory: boolean) => boolean;
};

export function createContextWindowPolicy(
  model: Model<Api>,
  system: string,
  tools: readonly object[],
): ContextWindowPolicy {
  const contextWindow = Math.max(1, model.contextWindow);
  const outputReserve = Math.max(
    MIN_OUTPUT_RESERVE_TOKENS,
    Math.min(MAX_OUTPUT_RESERVE_TOKENS, model.maxTokens, Math.floor(contextWindow * 0.2)),
  );
  const safetyMargin = Math.max(
    MIN_SAFETY_MARGIN_TOKENS,
    Math.min(MAX_SAFETY_MARGIN_TOKENS, Math.floor(contextWindow * 0.05)),
  );
  const fixedTokens = estimateTextTokens(system) + estimateTextTokens(safeJson(tools)) + outputReserve + safetyMargin;
  const messageBudget = Math.max(0, contextWindow - fixedTokens);
  const omission = omissionMessage();
  const omissionTokens = estimateMessageTokens(omission);

  return {
    messageBudget,
    fit: (messages) => fitMessages(messages, messageBudget, omission, omissionTokens),
    currentTurnFits(messages) {
      const conversation = messages.filter((message) => message.role !== "system");
      const start = lastUserIndex(conversation);
      if (start < 0) {
        return estimateMessageList(conversation) <= messageBudget;
      }
      const markerTokens = start > 0 ? omissionTokens : 0;
      return markerTokens + estimateMessageList(conversation.slice(start)) <= messageBudget;
    },
    userInputFits(text, hasHistory) {
      const message: UserMessage = { role: "user", content: text, timestamp: 0 };
      return estimateMessageTokens(message) + (hasHistory ? omissionTokens : 0) <= messageBudget;
    },
  };
}

export function fitMessages<T extends AgentMessage>(
  messages: T[],
  budget: number,
  omission = omissionMessage(),
  omissionTokens = estimateMessageTokens(omission),
): T[] {
  // System messages carry the prompt and tool declarations; the budget already excludes them, and they are never dropped.
  if (estimateConversation(messages) <= budget) {
    return messages;
  }

  const starts = userTurnStarts(messages);
  const currentStart = starts.at(-1);
  if (currentStart === undefined) {
    return messages;
  }

  let keptStart = currentStart;
  let used = omissionTokens + estimateConversation(messages.slice(currentStart));
  for (let index = starts.length - 2; index >= 0; index -= 1) {
    const start = starts[index];
    if (start === undefined) {
      continue;
    }
    const turnTokens = estimateConversation(messages.slice(start, keptStart));
    if (used + turnTokens > budget) {
      break;
    }
    used += turnTokens;
    keptStart = start;
  }

  const omitted = messages.slice(0, keptStart);
  if (omitted.every((message) => message.role === "system")) {
    return messages;
  }
  const system = omitted.filter((message) => message.role === "system");
  return [...system, omission as T, ...messages.slice(keptStart)];
}

export function estimateMessageList(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

function estimateConversation(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role !== "system") {
      total += estimateMessageTokens(message);
    }
  }
  return total;
}

function userTurnStarts(messages: readonly AgentMessage[]): number[] {
  const starts: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") {
      starts.push(index);
    }
  }
  return starts;
}

function lastUserIndex(messages: readonly AgentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      return index;
    }
  }
  return -1;
}

function omissionMessage(): UserMessage {
  return { role: "user", content: CONTEXT_OMISSION_TEXT, timestamp: 0 };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}
