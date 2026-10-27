import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

const STATION_NAMES = ["station.yaml", "station.yml"] as const;
const STATION_FIELDS = new Set(["plugins", "channel", "provider", "runtime"]);
export const RUNTIME_KINDS = ["legacy", "durable"] as const;
export type RuntimeKind = (typeof RUNTIME_KINDS)[number];

export type StationConfig = {
  /** Ordered local modules trusted to run inside this station process. */
  plugins: string[];
  channel?: string;
  provider?: string;
  /** Which agent runtime runs the capsule. Default: durable. */
  runtime?: RuntimeKind;
};

export type FindStationOptions = {
  cwd?: string;
  home?: string;
  explicit?: string;
  env?: NodeJS.ProcessEnv;
};

export function defaultStationConfig(): StationConfig {
  return { plugins: [] };
}

export function parseStationConfig(
  raw: unknown,
  source = "<station>",
  baseDir = process.cwd(),
): StationConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: station must be a mapping`);
  }
  const record = raw as Record<string, unknown>;
  for (const field of Object.keys(record)) {
    if (!STATION_FIELDS.has(field)) {
      throw new Error(`${source}: unknown station field ${field}`);
    }
  }

  const runtime = parseRuntimeKind(optionalString(record.runtime, `${source}: runtime`), `${source}: runtime`);
  return {
    plugins: parsePluginPaths(record.plugins, source, baseDir),
    channel: optionalString(record.channel, `${source}: channel`),
    provider: optionalString(record.provider, `${source}: provider`),
    ...(runtime === undefined ? {} : { runtime }),
  };
}

export function parseRuntimeKind(value: string | undefined, source: string): RuntimeKind | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(RUNTIME_KINDS as readonly string[]).includes(value)) {
    throw new Error(`${source} must be one of ${RUNTIME_KINDS.join(", ")}`);
  }
  return value as RuntimeKind;
}

export async function loadStationConfig(path: string, cwd = process.cwd()): Promise<StationConfig> {
  const resolved = resolve(cwd, path);
  let contents: string;
  try {
    contents = await readFile(resolved, "utf8");
  } catch (error) {
    throw new Error(`Station config not found: ${resolved}`, { cause: error });
  }
  return parseStationConfig(parseYaml(contents), resolved, dirname(resolved));
}

export async function findStationConfig(options: FindStationOptions = {}): Promise<string | undefined> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const explicit = options.explicit?.trim() || env.ZING_STATION?.trim();
  if (explicit) {
    return resolve(cwd, explicit);
  }
  for (const dir of [cwd, options.home]) {
    if (!dir) {
      continue;
    }
    for (const name of STATION_NAMES) {
      const candidate = join(dir, name);
      if (await isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function parsePluginPaths(raw: unknown, source: string, baseDir: string): string[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${source}: plugins must be a list of local paths`);
  }
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${source}: plugins must be a list of local paths`);
    }
    const path = resolve(baseDir, value.trim());
    if (seen.has(path)) {
      throw new Error(`${source}: duplicate plugin path ${value.trim()}`);
    }
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function optionalString(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${source} must be a non-empty string`);
  }
  return value.trim();
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
