import { splitList } from "./env";
import { parseRuntimeKind, type RuntimeKind, type StationConfig } from "./station-config";

export type Config = {
  model?: string;
  channel?: string;
  provider?: string;
  capsulePath?: string;
  pluginPaths: string[];
  runtime: RuntimeKind;
};

export type LoadConfigOptions = {
  station?: StationConfig;
  channel?: string;
  provider?: string;
  capsulePath?: string;
  pluginPaths?: readonly string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env, options: LoadConfigOptions = {}): Config {
  const station = options.station;
  return {
    model: emptyToUndefined(env.MODEL),
    channel: options.channel ?? emptyToUndefined(env.CHANNEL) ?? station?.channel,
    provider: options.provider ?? emptyToUndefined(env.PROVIDER) ?? station?.provider,
    capsulePath: options.capsulePath ?? emptyToUndefined(env.ZING_CAPSULE),
    pluginPaths: [...(station?.plugins ?? []), ...splitList(env.ZING_PLUGINS), ...(options.pluginPaths ?? [])],
    runtime: parseRuntimeKind(emptyToUndefined(env.ZING_RUNTIME), "ZING_RUNTIME") ?? station?.runtime ?? "durable",
  };
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
