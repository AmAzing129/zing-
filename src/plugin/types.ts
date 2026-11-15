import type { JsonValue, Provider, TSchema } from "@earendil-works/pi-ai";

import type { CapsuleState } from "../capsule";
import type { ThreadEntry, ThreadImageContent } from "../runtime";
export type { Provider } from "@earendil-works/pi-ai";

export type ModelProvider = {
  pluginId: string;
  provider: Provider;
  getApiKey?: () => string | undefined;
};

export type AgentResult = {
  text: string;
};

export type IncomingMessage = {
  conversationId: string;
  text: string;
  /** Images sent with the text. A model without image input sees a placeholder. */
  images?: ThreadImageContent[];
  senderId?: string;
  /** Stable per-message key, such as a platform update ID, so a redelivered message is answered once. */
  requestId?: string;
};

export type ConversationHost = {
  handleMessage: (message: IncomingMessage) => Promise<AgentResult>;
  resetConversation: (conversationId: string) => void | Promise<void>;
};

export type Channel = {
  readonly id: string;
  start: (signal: AbortSignal) => Promise<void>;
};

export type CapsuleRef = { readonly agentId: string; readonly state: CapsuleState };

/** What the model was given in a turn: the resolved model, the full system prompt, and the tool definitions. */
export type TurnContext = {
  provider: string;
  model: string;
  system: string;
  tools: Array<{ name: string; description: string; parameters: JsonValue }>;
};

export type ConversationEvent =
  | {
      type: "turn";
      conversationId: string;
      senderId?: string;
      capsule: CapsuleRef;
      status: "completed" | "failed" | "canceled";
      /** Entries appended and persisted by this turn, in thread/read shape. */
      entries: ThreadEntry[];
      /** The station's model, system prompt, and tools when the turn was observed. */
      context: TurnContext;
    }
  | { type: "reset"; conversationId: string; capsule: CapsuleRef };

export type ConversationListener = (
  event: ConversationEvent,
  signal: AbortSignal,
) => void | Promise<void>;

/** What a tool learns about the turn it runs in. */
export type ToolContext = {
  signal: AbortSignal;
  conversationId: string;
  senderId?: string;
  capsule: CapsuleRef;
};

/** A model-callable capability. Protocol-specific state belongs in execute's closure. */
export type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
  execute: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ text: string; details?: JsonValue }>;
};

export type ZingPluginAPI = {
  readonly host: ConversationHost;
  readonly env: NodeJS.ProcessEnv;
  requireEnv: (name: string) => string;
  conversationId: (channel: string, localId: string) => string;
  onConversation: (listener: ConversationListener) => () => void;
  registerChannel: (channel: Channel) => void;
  registerProvider: (provider: ModelProvider) => void;
  registerTool: (tool: Tool) => void;
};

export type PluginDisposer = () => void | Promise<void>;

export type ZingPlugin = (zing: ZingPluginAPI) => void | PluginDisposer | Promise<void | PluginDisposer>;
