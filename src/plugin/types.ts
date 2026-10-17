import type { JsonValue, Provider, TSchema } from "@earendil-works/pi-ai";

import type { Bundle } from "../bundle";
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
  /** Asks this message's sender to approve a tool call. Without it, calls that need approval are not run. */
  approve?: Approver;
};

/** A tool call waiting for the user's yes. */
export type ApprovalRequest = {
  tool: string;
  description: string;
  input: Record<string, unknown>;
};

/**
 * Ask the person who started the turn. Resolve true to run the call and false to decline it. The signal aborts when
 * the turn ends first, for example by cancellation or timeout; then the answer no longer matters.
 */
export type Approver = (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;

export type ConversationHost = {
  handleMessage: (message: IncomingMessage) => Promise<AgentResult>;
  resetConversation: (conversationId: string) => void | Promise<void>;
};

export type Channel = {
  readonly id: string;
  start: (signal: AbortSignal) => Promise<void>;
};

export type CapsuleRef = { readonly agentId: string; readonly state: CapsuleState };

export type ConversationEvent =
  | {
      type: "turn";
      conversationId: string;
      senderId?: string;
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
  capsule: CapsuleRef;
  /** The turn's approver, when its channel can ask the user. */
  approve?: Approver;
};

/** A model-callable capability. Protocol-specific state belongs in execute's closure. */
export type Tool = {
  name: string;
  description: string;
  parameters: TSchema;
  /** It only reads. A blueprint with approval: writes runs it without asking. */
  readOnly?: boolean;
  execute: (
    input: Record<string, unknown>,
    context: ToolContext,
  ) => Promise<{ text: string; details?: JsonValue }>;
};

/**
 * A JSON-RPC method that App Server clients may call, such as a client rendering a tool's interface. Zing only routes
 * the call: the plugin checks params and decides what the method may do.
 */
export type ClientMethod = {
  /** "<namespace>/<name>", such as "mcp/resources/read". Zing's own namespaces are reserved. */
  name: string;
  handle: (params: unknown, context: ClientMethodContext) => Promise<JsonValue>;
};

export type ClientMethodContext = {
  /** Aborts when the client's connection closes. */
  signal: AbortSignal;
};

export type ZingPluginAPI = {
  readonly host: ConversationHost;
  readonly env: NodeJS.ProcessEnv;
  /** The bundles station.yaml enables, in order. A plugin uses the parts it understands, such as MCP servers. */
  readonly bundles: readonly Bundle[];
  requireEnv: (name: string) => string;
  conversationId: (channel: string, localId: string) => string;
  onConversation: (listener: ConversationListener) => () => void;
  registerChannel: (channel: Channel) => void;
  registerProvider: (provider: ModelProvider) => void;
  registerTool: (tool: Tool) => void;
  /** Offer a method to App Server clients. Channels never call it. */
  registerMethod: (method: ClientMethod) => void;
};

export type PluginDisposer = () => void | Promise<void>;

export type ZingPlugin = (zing: ZingPluginAPI) => void | PluginDisposer | Promise<void | PluginDisposer>;
