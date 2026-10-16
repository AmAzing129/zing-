import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/** The portable Agent Plugins manifest, then the Codex layout that OpenAI's plugins use. */
const PORTABLE_MANIFEST = "plugin.json";
const CODEX_MANIFEST = join(".codex-plugin", "plugin.json");
const BUNDLE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;

/**
 * An Agent Plugins package, such as a ChatGPT or Codex plugin: skills and MCP server configuration.
 * A bundle is data. The Station never runs code from it; plugins decide what to do with its parts.
 */
export type Bundle = {
  name: string;
  version?: string;
  description?: string;
  /** The real path of the bundle's root directory. */
  dir: string;
  /** The real path of its skills directory: one Agent Skill per subdirectory. */
  skillsDir?: string;
  /** The real path of its MCP server file (mcp.json or .mcp.json). Its format belongs to the plugin that reads it. */
  mcpConfig?: string;
};

/** The manifest of the bundle rooted at dir, or undefined when dir is not a bundle. */
export async function findBundleManifest(dir: string): Promise<string | undefined> {
  for (const name of [PORTABLE_MANIFEST, CODEX_MANIFEST]) {
    const candidate = join(dir, name);
    if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/** Read the bundles a station enables, in order. A duplicate name fails the whole set. */
export async function loadBundles(paths: readonly string[]): Promise<Bundle[]> {
  const bundles: Bundle[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const bundle = await loadBundle(path);
    const previous = seen.get(bundle.name);
    if (previous !== undefined) {
      throw new Error(`Duplicate bundle name ${bundle.name}: ${previous} and ${path}`);
    }
    seen.set(bundle.name, path);
    bundles.push(bundle);
  }
  return bundles;
}

export async function loadBundle(path: string): Promise<Bundle> {
  let dir: string;
  try {
    dir = await realpath(path);
  } catch (error) {
    throw new Error(`Bundle not found: ${path}`, { cause: error });
  }
  const manifestPath = await findBundleManifest(dir);
  if (!manifestPath) {
    throw new Error(`Bundle ${path} has no ${PORTABLE_MANIFEST} or ${CODEX_MANIFEST}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${manifestPath}: invalid JSON`, { cause: error });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${manifestPath}: manifest must be a JSON object`);
  }
  const manifest = raw as Record<string, unknown>;
  const name = parseName(manifest.name, manifestPath);
  const portable = manifestPath === join(dir, PORTABLE_MANIFEST);

  // The portable format fixes component locations; the Codex layout may point elsewhere inside the bundle.
  const skillsDir = await component(dir, portable ? undefined : manifest.skills, "skills", manifestPath, isDirectory);
  const mcpConfig = portable
    ? await component(dir, undefined, "mcp.json", manifestPath, isFile)
    : await component(dir, manifest.mcpServers, ".mcp.json", manifestPath, isFile);

  if (!mcpConfig && (manifest.apps !== undefined || (await isFile(join(dir, ".app.json"))))) {
    console.warn(
      `Bundle ${name} has ChatGPT apps but no MCP server file. Apps connect only inside ChatGPT; Zing ignores them.`,
    );
  }

  return {
    name,
    version: optionalString(manifest.version, `${manifestPath}: version`),
    description: optionalString(manifest.description, `${manifestPath}: description`),
    dir,
    ...(skillsDir ? { skillsDir } : {}),
    ...(mcpConfig ? { mcpConfig } : {}),
  };
}

/** A component path the manifest declares, or its conventional location when the manifest names none. */
async function component(
  dir: string,
  declared: unknown,
  conventional: string,
  manifestPath: string,
  exists: (path: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (declared === undefined || declared === null) {
    return (await exists(join(dir, conventional))) ? insidePath(dir, `./${conventional}`, manifestPath) : undefined;
  }
  if (typeof declared !== "string") {
    throw new Error(`${manifestPath}: component paths must be strings such as "./${conventional}"`);
  }
  const path = await insidePath(dir, declared, manifestPath);
  if (!(await exists(path))) {
    throw new Error(`${manifestPath}: ${declared} does not exist`);
  }
  return path;
}

/** Resolve a manifest path. It starts with ./ and stays inside the bundle, also through symbolic links. */
async function insidePath(dir: string, value: string, manifestPath: string): Promise<string> {
  const segments = value.split(/[\\/]/);
  if (!value.startsWith("./") || segments.includes("..")) {
    throw new Error(`${manifestPath}: ${value} must start with ./ and stay inside the bundle`);
  }
  let real: string;
  try {
    real = await realpath(resolve(dir, value));
  } catch (error) {
    throw new Error(`${manifestPath}: ${value} does not exist`, { cause: error });
  }
  if (real !== dir && !real.startsWith(`${dir}${sep}`)) {
    throw new Error(`${manifestPath}: ${value} is outside the bundle`);
  }
  return real;
}

function parseName(value: unknown, manifestPath: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new Error(`${manifestPath}: name is required`);
  if (name.length > MAX_NAME_LENGTH || !BUNDLE_NAME.test(name)) {
    throw new Error(`${manifestPath}: invalid name "${name}". Use up to ${MAX_NAME_LENGTH} lowercase letters, digits, and single hyphens.`);
  }
  return name;
}

function optionalString(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${source} must be a string`);
  return value.trim() || undefined;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
