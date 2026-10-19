import { appendFileSync, readFileSync } from "node:fs";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseFactory,
  type JsonObject,
  type Message,
} from "@earendil-works/pi-ai";
import type { ZingPluginAPI } from "zing";

export const SCRIPTED_MODEL_ID = "e2e-model";

/** One model response. A turn's nth model request answers with the nth step scripted for its user text. */
export type ScriptStep =
  | { text: string }
  | { toolCalls: Array<{ name: string; arguments: JsonObject }> }
  | { error: string };

export type Script = Record<string, ScriptStep[]>;

/** What one model request carried, as the test reads it back from ZING_E2E_MODEL_LOG. */
export type ModelRequest = {
  prompt: string;
  round: number;
  system: string;
  tools: string[];
  messages: LoggedMessage[];
};

export type LoggedMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: string[] }
  | { role: "toolResult"; toolName: string; isError: boolean; text: string };

/**
 * A deterministic model for end-to-end tests. Replies are keyed by the turn's user text rather than consumed from one
 * queue, so concurrent threads and resumed turns get the same answers regardless of timing.
 */
export default function scriptedModel(zing: ZingPluginAPI) {
  const script = JSON.parse(readFileSync(zing.requireEnv("ZING_E2E_SCRIPT"), "utf8")) as Script;
  const log = zing.requireEnv("ZING_E2E_MODEL_LOG");
  const faux = fauxProvider({ provider: "e2e", models: [{ id: SCRIPTED_MODEL_ID, contextWindow: 64_000 }] });

  const respond: FauxResponseFactory = (context) => {
    // faux consumes one queued response per request; keep the queue topped up for concurrent requests.
    faux.appendResponses([respond]);
    const request = describe(context.messages);
    appendFileSync(log, `${JSON.stringify(request)}\n`);
    const step = script[request.prompt]?.[request.round];
    if (!step) {
      return reply({ error: `No scripted reply for ${JSON.stringify(request.prompt)} round ${request.round}` });
    }
    return reply(step);
  };
  faux.setResponses(Array.from({ length: 64 }, () => respond));
  zing.registerProvider({ pluginId: "e2e", provider: faux.provider, getApiKey: () => "e2e" });
}

/** Built at request time so the message timestamp is the response time, as with a real provider. */
function reply(step: ScriptStep): AssistantMessage {
  if ("text" in step) {
    return fauxAssistantMessage(step.text);
  }
  if ("toolCalls" in step) {
    return fauxAssistantMessage(
      step.toolCalls.map((call) => fauxToolCall(call.name, call.arguments)),
      { stopReason: "toolUse" },
    );
  }
  return fauxAssistantMessage([], { stopReason: "error", errorMessage: step.error });
}

function describe(messages: readonly Message[]): ModelRequest {
  const tools = new Set<string>();
  const system: string[] = [];
  const logged: LoggedMessage[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      system.push(textOf(message.content), ...Object.values(message.sections ?? {}).filter((s) => s !== null));
      for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    } else if (message.role === "user") {
      logged.push({ role: "user", text: textOf(message.content) });
    } else if (message.role === "assistant") {
      logged.push({
        role: "assistant",
        text: textOf(message.content),
        toolCalls: message.content.flatMap((block) => (block.type === "toolCall" ? [block.name] : [])),
      });
    } else if (message.role === "toolResult") {
      logged.push({
        role: "toolResult",
        toolName: message.toolName,
        isError: message.isError,
        text: textOf(message.content),
      });
    }
  }
  const lastUser = logged.map((message) => message.role).lastIndexOf("user");
  const prompt = lastUser === -1 ? "" : (logged[lastUser] as { text: string }).text;
  const round = logged.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
  return { prompt, round, system: system.join("\n"), tools: [...tools].sort(), messages: logged };
}

function textOf(content: string | ReadonlyArray<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  return content.flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : [])).join("");
}
