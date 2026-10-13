import { type StreamFn } from "@earendil-works/pi-agent-core";
import { createModels, type Api, type Model, type Models } from "@earendil-works/pi-ai";

import { findProvider } from "./plugin/registry";
import type { ModelProvider } from "./plugin/types";

/** Where a capsule docks: models, keys, and the process that keeps it awake. */
export type Station = {
  resolveModel: (id: string) => Model<Api>;
  /** The provider catalog behind streamFn, for runtimes that call pi-ai directly. */
  models: Models;
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
    models,
    streamFn: models.streamSimple.bind(models),
    getApiKey: (providerId) => findProvider(providers, providerId)?.getApiKey?.(),
  };
}

type ModelCatalog = {
  getModel: (provider: string, id: string) => Model<Api> | undefined;
  getModels: (provider?: string) => readonly Model<Api>[];
};

export function resolveModel(
  models: ModelCatalog,
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
    const model = models.getModel(entry.provider.id, id);
    if (!model) {
      throw new Error(`Unknown model: ${id} on provider ${entry.pluginId}. ${describeCatalog(models, [entry])}`);
    }
    return model;
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

  throw new Error(`Unknown model: ${id}. ${describeCatalog(models, providers)}`);
}

function describeCatalog(models: ModelCatalog, providers: readonly ModelProvider[]): string {
  const entries = providers.map((entry) => {
    const ids = models.getModels(entry.provider.id).map((model) => model.id);
    return `${entry.pluginId} (${ids.length > 0 ? ids.join(", ") : "no models"})`;
  });
  return `Available: ${entries.join("; ")}`;
}

function describeProviders(providers: readonly ModelProvider[]): string {
  const ids = providers.map((provider) => provider.pluginId);
  return ids.length > 0 ? `Registered: ${ids.join(", ")}` : "No provider plugins loaded.";
}
