import type { Bundle } from "../bundle";
import { requireEnv } from "../env";
import { SKILL_TOOL_NAME } from "../skills";
import { conversationId } from "./ids";
import type {
  Channel,
  ClientMethod,
  ConversationHost,
  ConversationListener,
  ModelProvider,
  Tool,
  ZingPluginAPI,
} from "./types";

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const METHOD_NAME = /^[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)+$/;
const MAX_METHOD_LENGTH = 128;
/** The App Server's own methods and notifications live here. */
const RESERVED_NAMESPACES = new Set(["approval", "message", "thread", "tool", "turn", "zing"]);

export type PluginRegistry = {
  readonly api: ZingPluginAPI;
  bindHost: (host: ConversationHost) => void;
  getChannel: (id: string) => Channel | undefined;
  listChannels: () => Channel[];
  listListeners: () => readonly ConversationListener[];
  getProvider: (id: string) => ModelProvider | undefined;
  listProviders: () => ModelProvider[];
  getTool: (name: string) => Tool | undefined;
  listTools: () => Tool[];
  listMethods: () => ClientMethod[];
};

export function createPluginRegistry(
  options: {
    host?: ConversationHost;
    env?: NodeJS.ProcessEnv;
    bundles?: readonly Bundle[];
  } = {},
): PluginRegistry {
  const env = options.env ?? process.env;
  let host = options.host;
  const channels = new Map<string, Channel>();
  const providers = new Map<string, ModelProvider>();
  const tools = new Map<string, Tool>();
  const methods = new Map<string, ClientMethod>();
  const listeners: ConversationListener[] = [];

  const api: ZingPluginAPI = {
    get host() {
      if (!host) {
        throw new Error("Plugin host is not ready. Use zing.host inside channel.start(signal), not in the plugin factory.");
      }
      return host;
    },
    env,
    bundles: options.bundles ?? [],
    requireEnv: (name) => requireEnv(env, name),
    conversationId,
    onConversation(listener) {
      listeners.push(listener);
      return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
    registerChannel(channel) {
      const id = channel.id.trim();
      if (!id) {
        throw new Error("Channel id is required");
      }
      if (channels.has(id)) {
        throw new Error(`Channel already registered: ${id}`);
      }
      channels.set(id, { ...channel, id });
    },
    registerProvider(entry) {
      const id = entry.pluginId.trim();
      if (!id) {
        throw new Error("Provider pluginId is required");
      }
      if (providers.has(id)) {
        throw new Error(`Provider already registered: ${id}`);
      }
      const providerId = entry.provider?.id?.trim();
      if (!providerId) {
        throw new Error("Provider id is required");
      }
      if ([...providers.values()].some((registered) => registered.provider.id === providerId)) {
        throw new Error(`Provider already registered: ${providerId}`);
      }
      providers.set(id, { ...entry, pluginId: id });
    },
    registerTool(tool) {
      const name = tool.name.trim();
      if (!TOOL_NAME.test(name)) {
        throw new Error(`Invalid tool name: ${tool.name}. Use 1-64 lowercase letters, digits, or underscores.`);
      }
      if (name === SKILL_TOOL_NAME) {
        throw new Error(`Tool name ${name} is reserved: Zing provides it for the skills listed in agent.yaml`);
      }
      if (tools.has(name)) {
        throw new Error(`Tool already registered: ${name}`);
      }
      tools.set(name, { ...tool, name });
    },
    registerMethod(method) {
      const name = method.name.trim();
      if (name.length > MAX_METHOD_LENGTH || !METHOD_NAME.test(name)) {
        throw new Error(
          `Invalid method name: ${method.name}. Use <namespace>/<name> with lowercase letters, digits, _ and -, such as mcp/tools/call.`,
        );
      }
      const namespace = name.slice(0, name.indexOf("/"));
      if (RESERVED_NAMESPACES.has(namespace)) {
        throw new Error(`Method namespace ${namespace}/ is reserved for the App Server`);
      }
      if (methods.has(name)) {
        throw new Error(`Method already registered: ${name}`);
      }
      methods.set(name, { ...method, name });
    },
  };

  return {
    api,
    bindHost(next) {
      host = next;
    },
    getChannel: (id) => channels.get(id),
    listChannels: () => [...channels.values()],
    listListeners: () => listeners,
    getProvider: (id) => findProvider([...providers.values()], id),
    listProviders: () => [...providers.values()],
    getTool: (name) => tools.get(name),
    listTools: () => [...tools.values()],
    listMethods: () => [...methods.values()],
  };
}

export function selectChannel(registry: PluginRegistry, requested?: string): Channel {
  if (requested) {
    const channel = registry.getChannel(requested);
    if (!channel) {
      throw new Error(`Unknown channel: ${requested}. ${describeChannels(registry)}`);
    }
    return channel;
  }

  const registered = registry.listChannels();
  const plugins = registered.filter((channel) => channel.id !== "stdio");
  const onlyPlugin = plugins.length === 1 ? plugins[0] : undefined;
  if (onlyPlugin) {
    return onlyPlugin;
  }
  const onlyRegistered = registered.length === 1 ? registered[0] : undefined;
  if (plugins.length === 0 && onlyRegistered) {
    return onlyRegistered;
  }
  if (plugins.length === 0) {
    throw new Error("No channel plugin loaded. Enable one in station.yaml or pass --plugin <path>.");
  }
  throw new Error(
    `Multiple channels registered (${plugins.map((channel) => channel.id).join(", ")}). Set CHANNEL=<id> or pass --channel.`,
  );
}

function describeChannels(registry: PluginRegistry): string {
  const ids = registry.listChannels().map((channel) => channel.id);
  return ids.length > 0 ? `Registered: ${ids.join(", ")}` : "No channel plugins loaded.";
}

export function selectProvider(registry: PluginRegistry, requested?: string): ModelProvider {
  if (requested) {
    const provider = registry.getProvider(requested);
    if (!provider) {
      throw new Error(`Unknown provider: ${requested}. ${describeProviders(registry.listProviders())}`);
    }
    return provider;
  }

  const registered = registry.listProviders();
  const only = registered.length === 1 ? registered[0] : undefined;
  if (only) {
    return only;
  }
  if (registered.length === 0) {
    throw new Error("No provider plugin loaded. Enable one in station.yaml or pass --plugin <path>.");
  }
  throw new Error(
    `Multiple provider plugins registered (${registered.map((provider) => provider.pluginId).join(", ")}). Set PROVIDER=<id> or pass --provider.`,
  );
}

export function findProvider(providers: readonly ModelProvider[], id: string): ModelProvider | undefined {
  return providers.find((entry) => entry.pluginId === id || entry.provider.id === id);
}

function describeProviders(providers: readonly ModelProvider[]): string {
  const ids = providers.map((provider) => provider.pluginId);
  return ids.length > 0 ? `Registered: ${ids.join(", ")}` : "No provider plugins loaded.";
}
