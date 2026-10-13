import type { Storage } from "@earendil-works/pi-durable";

import { createAgent, type Agent } from "./agent";
import { resolveBlueprintTools, type Blueprint } from "./blueprint";
import type { Capsule } from "./capsule";
import { createDispatcher } from "./dispatcher";
import type { ConversationHost } from "./plugin/types";
import {
  createPluginRegistry,
  loadPlugins,
  resolvePluginPaths,
  type PluginRegistry,
} from "./plugin/index";
import { createStation } from "./station";

export type CapsuleFactory = (blueprint: Blueprint) => Promise<Capsule>;

export type CreateZingHostOptions = {
  blueprint: Blueprint;
  capsuleFactory: CapsuleFactory;
  pluginPaths?: readonly string[];
  provider?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  configureRegistry?: (registry: PluginRegistry) => void | Promise<void>;
  /** Run the capsule on the durable runtime, over the storage this opens. Absent: the legacy runtime. */
  durableStorage?: (capsule: Capsule) => Promise<Storage>;
  /** The durable runtime stopped after a storage failure it cannot recover from in this process. */
  onFatal?: (error: Error) => void;
};

export type ZingHost = {
  readonly agent: Agent;
  /** Runs triggers and delivers their replies; the host plugins see as zing.host. */
  readonly dispatcher: ConversationHost;
  readonly registry: PluginRegistry;
  close: () => Promise<void>;
};

export async function createZingHost(options: CreateZingHostOptions): Promise<ZingHost> {
  const registry = createPluginRegistry({ env: options.env });
  await options.configureRegistry?.(registry);
  const closePlugins = await loadPlugins(
    registry,
    resolvePluginPaths(options.pluginPaths ?? [], options.cwd),
    options.cwd,
  );

  let closeStorage: (() => Promise<void>) | undefined;
  try {
    const station = createStation({ providers: registry.listProviders(), provider: options.provider });
    const capsule = await options.capsuleFactory(options.blueprint);
    const tools = resolveBlueprintTools(options.blueprint, registry);
    const agentOptions = { tools, listeners: registry.listListeners() };
    // pi-durable loads TypeBox and Chord; a legacy station never imports it.
    let agent: Agent;
    if (options.durableStorage) {
      const { createDurableAgent } = await import("./durable");
      const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
      const acquired = await options.durableStorage(capsule);
      let closing: Promise<void> | undefined;
      const close: Storage["close"] = (context) => {
        closing ??= Promise.resolve().then(() => acquired.close(context));
        return closing;
      };
      closeStorage = () => close(BACKGROUND_CONTEXT);
      // Both constructor failure cleanup and the harness may close storage. Share one attempt,
      // including its rejection, and preserve the receiver of storage implementations' methods.
      const storage = new Proxy(acquired, {
        get(target, key) {
          if (key === "close") return close;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      agent = await createDurableAgent(station, options.blueprint, capsule, {
        ...agentOptions,
        storage,
        onFatal: options.onFatal,
      });
    } else {
      agent = createAgent(station, options.blueprint, capsule, agentOptions);
    }
    const dispatcher = createDispatcher({
      agent,
      state: capsule.state,
      getChannel: (id) => registry.getChannel(id),
    });
    registry.bindHost(dispatcher, { agentId: agent.agentId, state: capsule.state });

    let closing: Promise<void> | undefined;
    return {
      agent,
      dispatcher,
      registry,
      close() {
        closing ??= closeHost(agent, closePlugins);
        return closing;
      },
    };
  } catch (error) {
    return closeAfterFailure(error, closePlugins, closeStorage);
  }
}

async function closeHost(agent: Agent, closePlugins: () => void | Promise<void>): Promise<void> {
  const errors: unknown[] = [];
  try {
    await agent.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await closePlugins();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Zing host cleanup failed");
  }
}

async function closeAfterFailure(
  error: unknown,
  closePlugins: () => void | Promise<void>,
  closeStorage?: () => Promise<void>,
): Promise<never> {
  const errors = [error];
  for (const cleanup of [closeStorage, closePlugins]) {
    try {
      await cleanup?.();
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "Zing host creation and cleanup failed");
  }
  throw error;
}
