import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { PluginRegistry } from "./registry";
import { installZingSpecifier } from "./specifier";
import type { PluginDisposer } from "./types";

const PLUGIN_INDEX = ["index.ts", "index.mts", "index.mjs", "index.js"] as const;

export function resolvePluginPaths(paths: readonly string[], cwd = process.cwd()): string[] {
  return [...new Set(paths.map((path) => resolve(cwd, path)))];
}

export async function loadPlugins(
  registry: PluginRegistry,
  paths: readonly string[],
  cwd = process.cwd(),
): Promise<PluginDisposer> {
  const disposers: PluginDisposer[] = [];
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= closeDisposers(disposers);
    return closing;
  };

  try {
    for (const path of paths) {
      const dispose = await loadPlugin(registry, path, cwd);
      if (dispose) {
        disposers.push(dispose);
      }
    }
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Plugin loading and cleanup failed");
    }
    throw error;
  }

  return close;
}

export async function loadPlugin(
  registry: PluginRegistry,
  spec: string,
  cwd = process.cwd(),
): Promise<PluginDisposer | undefined> {
  installZingSpecifier();
  const resolved = resolve(cwd, spec);
  const entry = await resolvePluginEntry(resolved);
  let module: { default?: unknown };
  try {
    module = (await import(pathToFileURL(entry).href)) as { default?: unknown };
  } catch (error) {
    throw new Error(`Failed to import plugin ${entry}`, { cause: error });
  }
  const factory = module.default;
  if (typeof factory !== "function") {
    throw new Error(`Plugin ${entry} must default-export a function`);
  }
  const dispose = await factory(registry.api);
  if (dispose !== undefined && typeof dispose !== "function") {
    throw new Error(`Plugin ${entry} must return a disposer function or nothing`);
  }
  return dispose as PluginDisposer | undefined;
}

async function closeDisposers(disposers: readonly PluginDisposer[]): Promise<void> {
  const errors: unknown[] = [];
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      await disposers[index]?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Plugin cleanup failed");
  }
}

async function resolvePluginEntry(target: string): Promise<string> {
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    throw new Error(`Plugin not found: ${target}`, { cause: error });
  }

  if (info.isFile()) {
    return target;
  }
  if (!info.isDirectory()) {
    throw new Error(`Not a plugin path: ${target}`);
  }

  const declared = await readDeclaredEntry(target);
  if (declared) {
    if (!(await exists(declared))) {
      throw new Error(`Plugin entry not found: ${declared}`);
    }
    return declared;
  }

  for (const name of PLUGIN_INDEX) {
    const candidate = join(target, name);
    if (await exists(candidate)) {
      return candidate;
    }
  }

  throw new Error(`No plugin entry found in ${target}`);
}

async function readDeclaredEntry(dir: string): Promise<string | undefined> {
  const pkgFile = join(dir, "package.json");
  if (!(await exists(pkgFile))) {
    return undefined;
  }

  const pkg = JSON.parse(await readFile(pkgFile, "utf8")) as {
    zing?: { plugin?: string };
    main?: string;
  };
  const declared = pkg.zing?.plugin ?? pkg.main;
  if (!declared) {
    return undefined;
  }
  return resolve(dir, declared);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isEnoent(error)) {
      return false;
    }
    throw error;
  }
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
