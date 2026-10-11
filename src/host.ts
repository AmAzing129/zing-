import { createAgent, type Agent } from "./agent";
import { resolveBlueprintTools, type Blueprint } from "./blueprint";
import type { Capsule } from "./capsule";
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
};

export type ZingHost = {
  readonly agent: Agent;
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

  try {
    const station = createStation({ providers: registry.listProviders(), provider: options.provider });
    const capsule = await options.capsuleFactory(options.blueprint);
    const tools = resolveBlueprintTools(options.blueprint, registry);
    const agent = createAgent(station, options.blueprint, capsule, {
      tools,
      listeners: registry.listListeners(),
    });
    registry.bindHost(agent);

    let closing: Promise<void> | undefined;
    return {
      agent,
      registry,
      close() {
        closing ??= closeHost(agent, closePlugins);
        return closing;
      },
    };
  } catch (error) {
    return closeAfterFailure(error, closePlugins);
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

async function closeAfterFailure(error: unknown, closePlugins: () => void | Promise<void>): Promise<never> {
  try {
    await closePlugins();
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], "Zing host creation and cleanup failed");
  }
  throw error;
}
