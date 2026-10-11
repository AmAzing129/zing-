import { type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";

import { findProvider } from "./plugin/registry";
import type { ModelProvider } from "./plugin/types";

/** Where a capsule docks: models, keys, and the process that keeps it awake. */
export type Station = {
  resolveModel: (id: string) => Model<Api>;
  streamFn: StreamFn;
  getApiKey: (provider: string) => string | undefined;
};

export type CreateStationOptions = {
  providers: readonly ModelProvider[];
  provider?: string;
};

export function createStation(options: CreateStationOptions): Station {
  const providers = options.providers;
  if (providers.length === 0) {
    throw new Error("No provider plugin loaded. Enable one in station.yaml or pass --plugin <path>.");
  }
  if (options.provider) {
    const selected = findProvider(providers, options.provider);
    if (!selected) {
      throw new Error(`Unknown provider: ${options.provider}. ${describeProviders(providers)}`);
    }
  }

  const models = createModels();
  for (const entry of providers) {
    models.setProvider(entry.provider);
  }

  return {
    resolveModel: (id) => resolveModel(models, providers, id, options.provider),
    streamFn: models.streamSimple.bind(models),
    getApiKey: (providerId) => findProvider(providers, providerId)?.getApiKey?.(),
  };
}

export function resolveModel(
  models: {
    getModel: (provider: string, id: string) => Model<Api> | undefined;
    getModels: (provider?: string) => readonly Model<Api>[];
  },
  providers: readonly ModelProvider[],
  id: string,
  preferred?: string,
): Model<Api> {
  if (providers.length === 0) {
    throw new Error("No provider plugin loaded. Enable one in station.yaml or pass --plugin <path>.");
  }

  if (preferred) {
    const entry = findProvider(providers, preferred);
    if (!entry) {
      throw new Error(`Unknown provider: ${preferred}. ${describeProviders(providers)}`);
    }
    return modelOnProvider(models, entry, id);
  }

  const matches: Model<Api>[] = [];
  const matchedIds: string[] = [];
  for (const entry of providers) {
    const model = models.getModel(entry.provider.id, id);
    if (model) {
      matches.push(model);
      matchedIds.push(entry.pluginId);
    }
  }

  const onlyMatch = matches.length === 1 ? matches[0] : undefined;
  if (onlyMatch) {
    return onlyMatch;
  }
  if (matches.length > 1) {
    throw new Error(
      `Model ${id} is served by multiple providers (${matchedIds.join(", ")}). Set PROVIDER=<id> or pass --provider.`,
    );
  }

  const onlyProvider = providers.length === 1 ? providers[0] : undefined;
  if (onlyProvider) {
    return modelOnProvider(models, onlyProvider, id);
  }

  throw new Error(`Unknown model: ${id}. ${describeProviders(providers)}`);
}

function modelOnProvider(
  models: {
    getModel: (provider: string, id: string) => Model<Api> | undefined;
    getModels: (provider?: string) => readonly Model<Api>[];
  },
  entry: ModelProvider,
  id: string,
): Model<Api> {
  const exact = models.getModel(entry.provider.id, id);
  if (exact) {
    return exact;
  }
  const template = models.getModels(entry.provider.id)[0];
  if (!template) {
    throw new Error(`Provider ${entry.pluginId} has no models`);
  }
  return { ...template, id, name: id };
}

function describeProviders(providers: readonly ModelProvider[]): string {
  const ids = providers.map((provider) => provider.pluginId);
  return ids.length > 0 ? `Registered: ${ids.join(", ")}` : "No provider plugins loaded.";
}
