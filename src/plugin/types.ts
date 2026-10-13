import type { JsonValue, Provider, TSchema } from "@earendil-works/pi-ai";

import type { CapsuleState } from "../capsule";
import type { ThreadEntry } from "../runtime";
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
  senderId?: string;
  /** Stable per-message key, such as a platform update ID, so a redelivered message is answered once. */
  requestId?: string;
};

/** What kind of event started a turn. A user message is kind "message"; other kinds are automated. */
export type TriggerInfo = {
  kind: string;
  /** Which source fired it, for example "schedule:job_1" or "webhook:github". */
  source?: string;
};

/** A channel-local address, such as a Telegram chat id. */
export type Route = {
  channel: string;
  to: string;
};

/** Anything that wakes the agent in a conversation: a user message, a schedule, a webhook, ... */
export type Trigger = TriggerInfo & {
  conversationId: string;
  text: string;
  /** A human sender. Only message triggers carry one. */
  senderId?: string;
  /** Deduplication key scoped to the conversation, e.g. a chat message id; see IncomingMessage.requestId. */
  requestId?: string;
  /**
   * Where the reply goes. A Route delivers there and becomes the conversation's remembered route;
   * "conversation" delivers to the remembered route. Omitted: the caller consumes the result.
   */
  deliver?: Route | "conversation";
};

export type ConversationHost = {
  dispatch: (trigger: Trigger) => Promise<AgentResult>;
  /** Shorthand for a message trigger whose reply the caller delivers. */
  handleMessage: (message: IncomingMessage) => Promise<AgentResult>;
  resetConversation: (conversationId: string) => void | Promise<void>;
};

/** A long-running producer of triggers, such as a scheduler or a webhook server. */
export type TriggerSource = {
  readonly id: string;
  /** Run until the signal aborts, then resolve after in-flight dispatches settle. */
  start: (signal: AbortSignal) => Promise<void>;
};

export type OutboundMessage = {
  conversationId: string;
  to: string;
  text: string;
};

/** A two-way trigger source: it fires message triggers and, with send, delivers replies. */
export type Channel = TriggerSource & {
  send?: (message: OutboundMessage) => Promise<void>;
};

export type CapsuleRef = { readonly agentId: string; readonly state: CapsuleState };

export type ConversationEvent =
  | {
      type: "turn";
      conversationId: string;
      senderId?: string;
      trigger: TriggerInfo;
      capsule: CapsuleRef;
      status: "completed" | "failed" | "canceled";
      /** Entries appended and persisted by this turn, in thread/read shape. */
      entries: ThreadEntry[];
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
  trigger: TriggerInfo;
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
  /** Available once the station is bound, i.e. inside start(signal) and tool calls. */
  readonly host: ConversationHost;
  /** This agent's capsule. Available once the station is bound. */
  readonly capsule: CapsuleRef;
  readonly env: NodeJS.ProcessEnv;
  requireEnv: (name: string) => string;
  conversationId: (channel: string, localId: string) => string;
  onConversation: (listener: ConversationListener) => () => void;
  registerChannel: (channel: Channel) => void;
  registerTriggerSource: (source: TriggerSource) => void;
  registerProvider: (provider: ModelProvider) => void;
  registerTool: (tool: Tool) => void;
};

export type PluginDisposer = () => void | Promise<void>;

export type ZingPlugin = (zing: ZingPluginAPI) => void | PluginDisposer | Promise<void | PluginDisposer>;
