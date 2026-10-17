import { readFile } from "node:fs/promises";

import type { Bundle } from "zing";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const DEFAULT_CALLBACK_PORT = 33418;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_PART = /^[a-z][a-z0-9_]*$/;
const PLACEHOLDER = /^<([A-Z][A-Z0-9_]*)>$/;

/**
 * - modern: exactly 2026-07-28.
 * - legacy: exactly 2025-11-25, for the MCP_URL server with MCP_PROTOCOL_VERSION.
 * - fallback: 2026-07-28 when the server offers it, else 2025-11-25. Only for servers listed in MCP_LEGACY_SERVERS.
 */
export type ProtocolPolicy = "modern" | "legacy" | "fallback";

export type OAuthSettings = {
  /** The loopback port of the redirect URL registered with the authorization server. */
  callbackPort: number;
  scopes?: string[];
  /** RFC 8707 resource indicator, when it differs from the server URL. */
  resource?: string;
  /** A client the bundle registered in advance. Without it, Zing registers itself dynamically. */
  clientId?: string;
  clientSecret?: string;
  /** The unset variable a bundle's "<NAME>" client id placeholder names, for messages when registration fails. */
  clientIdVariable?: string;
};

/** One remote MCP server and how Zing names its tools. */
export type McpServer = {
  /** Prefix of its tool names, and the key of its stored credentials. */
  alias: string;
  /** The bundle that declares it; absent for the MCP_URL server. */
  bundle?: Bundle;
  url: URL;
  headers: Record<string, string>;
  /** A fixed credential. Without one, the server may use OAuth credentials from mcp-connect. */
  bearerToken?: string;
  oauth: OAuthSettings;
  protocol: ProtocolPolicy;
  /**
   * explicit: the remote name must already be a valid name part, or have an alias.
   * derived: hyphens and camelCase become underscores (notion-search -> notion_search).
   */
  naming: { kind: "explicit"; aliases: Record<string, string> } | { kind: "derived" };
};

/** The server configured by MCP_URL, or undefined without it. */
export function envServer(env: NodeJS.ProcessEnv): McpServer | undefined {
  const rawUrl = env.MCP_URL?.trim();
  if (!rawUrl) return undefined;
  const alias = env.MCP_SERVER_ALIAS?.trim() ?? "";
  if (!TOOL_PART.test(alias)) {
    throw new Error(
      "MCP_SERVER_ALIAS must start with a lowercase letter and contain only lowercase letters, digits, or underscores",
    );
  }
  const version = env.MCP_PROTOCOL_VERSION?.trim() || MODERN_PROTOCOL_VERSION;
  if (version !== MODERN_PROTOCOL_VERSION && version !== LEGACY_PROTOCOL_VERSION) {
    throw new Error(
      `MCP_PROTOCOL_VERSION must be ${MODERN_PROTOCOL_VERSION} or the explicit compatibility version ${LEGACY_PROTOCOL_VERSION}`,
    );
  }
  const token = env.MCP_BEARER_TOKEN?.trim();
  return {
    alias,
    url: parseUrl(rawUrl, "MCP_URL"),
    headers: {},
    ...(token ? { bearerToken: token } : {}),
    oauth: { callbackPort: DEFAULT_CALLBACK_PORT },
    protocol: version === MODERN_PROTOCOL_VERSION ? "modern" : "legacy",
    naming: { kind: "explicit", aliases: parseToolAliases(env.MCP_TOOL_ALIASES) },
  };
}

/**
 * The remote servers in a bundle's MCP file. It accepts both the portable mcp.json and the Codex .mcp.json fields.
 * Servers that run a local command are skipped: a bundle is data, and Zing does not start its programs.
 */
export async function bundleServers(bundle: Bundle, env: NodeJS.ProcessEnv): Promise<McpServer[]> {
  if (!bundle.mcpConfig) return [];
  const file = bundle.mcpConfig;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${file}: invalid JSON`, { cause: error });
  }
  const entries = record(record(raw, file).mcpServers ?? {}, `${file}: mcpServers`);
  const legacy = new Set(splitList(env.MCP_LEGACY_SERVERS));
  const servers: McpServer[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const source = `${file}: mcpServers.${key}`;
    const entry = record(value, source);
    const type = optionalString(entry.type, `${source}.type`);
    if (entry.command !== undefined || type === "stdio") {
      console.warn(`Bundle ${bundle.name}: MCP server ${key} runs a local command, which Zing does not start.`);
      continue;
    }
    if (type !== undefined && type !== "http" && type !== "streamable-http") {
      console.warn(`Bundle ${bundle.name}: MCP server ${key} uses transport ${type}; Zing supports Streamable HTTP.`);
      continue;
    }
    const alias = derivedPart(key);
    if (!alias) throw new Error(`${source}: the name ${key} has no usable tool prefix`);
    const auth = openaiAuth(entry, source);
    const oauth = record(entry.oauth ?? {}, `${source}.oauth`);
    const scopes =
      stringList(entry.scopes, `${source}.scopes`) ??
      stringList(auth.defaultScopes, `${source} auth.defaultScopes`) ??
      stringList(auth.baseScopes, `${source} auth.baseScopes`);
    const resource =
      optionalString(entry.oauth_resource, `${source}.oauth_resource`) ?? optionalString(auth.resource, `${source} auth.resource`);
    const client = record(auth.client ?? {}, `${source} auth.client`);
    const clientId =
      optionalString(oauth.client_id, `${source}.oauth.client_id`) ??
      optionalString(client.clientId, `${source} auth.client.clientId`);
    const clientSecret = optionalString(oauth.client_secret, `${source}.oauth.client_secret`);
    const resolvedId = clientId === undefined ? undefined : fromEnv(clientId, env);
    const resolvedSecret = clientSecret === undefined ? undefined : fromEnv(clientSecret, env);
    const callbackPort = oauth.callback_port ?? DEFAULT_CALLBACK_PORT;
    if (typeof callbackPort !== "number" || !Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535) {
      throw new Error(`${source}.oauth.callback_port must be a port number`);
    }
    const bearerToken = bearer(entry, auth, alias, env, source);
    servers.push({
      alias,
      bundle,
      url: parseUrl(optionalString(entry.url, `${source}.url`) ?? "", `${source}.url`),
      headers: headers(entry, env, source),
      ...(bearerToken ? { bearerToken } : {}),
      oauth: {
        callbackPort,
        ...(scopes ? { scopes } : {}),
        ...(resource ? { resource } : {}),
        ...(resolvedId?.value ? { clientId: resolvedId.value } : {}),
        ...(resolvedId?.value && resolvedSecret?.value ? { clientSecret: resolvedSecret.value } : {}),
        ...(resolvedId?.missing ? { clientIdVariable: resolvedId.missing } : {}),
      },
      protocol: legacy.has(alias) ? "fallback" : "modern",
      naming: { kind: "derived" },
    });
  }
  return servers;
}

/** Every server the station configures: MCP_URL first, then the bundles' servers in order. Aliases are unique. */
export async function configuredServers(env: NodeJS.ProcessEnv, bundles: readonly Bundle[]): Promise<McpServer[]> {
  const servers: McpServer[] = [];
  const fromEnv = envServer(env);
  if (fromEnv) servers.push(fromEnv);
  for (const bundle of bundles) servers.push(...(await bundleServers(bundle, env)));
  const seen = new Map<string, McpServer>();
  for (const server of servers) {
    const previous = seen.get(server.alias);
    if (previous !== undefined) {
      throw new Error(
        `MCP servers from ${describeOrigin(previous)} and ${describeOrigin(server)} share the tool prefix ${server.alias}`,
      );
    }
    seen.set(server.alias, server);
  }
  const unknown = splitList(env.MCP_LEGACY_SERVERS).filter((alias) => !seen.has(alias));
  if (unknown.length > 0) {
    throw new Error(`MCP_LEGACY_SERVERS names servers that are not configured: ${unknown.join(", ")}`);
  }
  return servers;
}

/** Where a server is configured, for messages. */
export function describeOrigin(server: McpServer): string {
  return server.bundle ? `bundle ${server.bundle.name}` : "MCP_URL";
}

/** The Zing name of a remote tool. Names never collide silently: the caller rejects duplicates. */
export function localToolName(server: Pick<McpServer, "alias" | "naming">, remoteName: string): string {
  let part: string;
  if (server.naming.kind === "explicit") {
    part = server.naming.aliases[remoteName] ?? remoteName;
    if (!TOOL_PART.test(part)) {
      throw new Error(`MCP tool ${remoteName} needs an explicit alias in MCP_TOOL_ALIASES`);
    }
  } else {
    part = derivedPart(remoteName);
    if (!part) throw new Error(`MCP tool ${remoteName} from ${server.alias} has no usable name`);
  }
  const name = `${server.alias}__${part}`;
  if (!TOOL_NAME.test(name)) {
    throw new Error(`MCP tool name is invalid or longer than 64 characters: ${name}`);
  }
  return name;
}

/** notion-search -> notion_search, getJiraIssue -> get_jira_issue. Empty when nothing usable remains. */
export function derivedPart(name: string): string {
  const part = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return TOOL_PART.test(part) ? part : "";
}

export function parseToolAliases(value: string | undefined): Record<string, string> {
  if (!value?.trim()) {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error("MCP_TOOL_ALIASES must be a JSON object", { cause: error });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("MCP_TOOL_ALIASES must be a JSON object");
  }
  const aliases: Record<string, string> = {};
  for (const [remoteName, localAlias] of Object.entries(raw)) {
    if (typeof localAlias !== "string" || !TOOL_PART.test(localAlias)) {
      throw new Error(`Invalid MCP tool alias for ${remoteName}`);
    }
    aliases[remoteName] = localAlias;
  }
  return aliases;
}

/** extensions["com.openai"].auth of a portable mcp.json server. */
function openaiAuth(entry: Record<string, unknown>, source: string): Record<string, unknown> {
  const extensions = record(entry.extensions ?? {}, `${source}.extensions`);
  const openai = record(extensions["com.openai"] ?? {}, `${source}.extensions["com.openai"]`);
  return record(openai.auth ?? {}, `${source} auth`);
}

/** A fixed credential: Codex bearer_token_env_var, or a portable api_key read from MCP_<ALIAS>_API_KEY. */
function bearer(
  entry: Record<string, unknown>,
  auth: Record<string, unknown>,
  alias: string,
  env: NodeJS.ProcessEnv,
  source: string,
): string | undefined {
  const variable = optionalString(entry.bearer_token_env_var, `${source}.bearer_token_env_var`);
  if (variable) return requireValue(env, variable, `${source}.bearer_token_env_var`);
  if (auth.type !== "api_key") return undefined;
  if (auth.headerScheme !== undefined && auth.headerScheme !== "bearer") {
    throw new Error(`${source}: api_key headerScheme ${String(auth.headerScheme)} is not supported; use bearer`);
  }
  return requireValue(env, `MCP_${alias.toUpperCase()}_API_KEY`, `${source} api_key`);
}

function headers(entry: Record<string, unknown>, env: NodeJS.ProcessEnv, source: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(record(entry.http_headers ?? entry.headers ?? {}, `${source}.http_headers`))) {
    if (typeof value !== "string") throw new Error(`${source}: header ${name} must be a string`);
    result[name] = value;
  }
  for (const [name, variable] of Object.entries(record(entry.env_http_headers ?? {}, `${source}.env_http_headers`))) {
    if (typeof variable !== "string") throw new Error(`${source}: env_http_headers.${name} must name a variable`);
    result[name] = requireValue(env, variable, `${source}.env_http_headers.${name}`);
  }
  return result;
}

/**
 * A "<NAME>" placeholder in a published bundle stands for the environment variable NAME: OpenAI fills in its own
 * registered client there. When NAME is unset, the server is used without that client.
 */
function fromEnv(value: string, env: NodeJS.ProcessEnv): { value?: string; missing?: string } {
  const variable = PLACEHOLDER.exec(value)?.[1];
  if (!variable) return { value };
  const resolved = env[variable]?.trim();
  return resolved ? { value: resolved } : { missing: variable };
}

function requireValue(env: NodeJS.ProcessEnv, variable: string, source: string): string {
  const value = env[variable]?.trim();
  if (!value) throw new Error(`${source} needs the environment variable ${variable}`);
  return value;
}

function parseUrl(value: string, source: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`${source} must be a valid URL`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${source} must use http or https`);
  }
  return url;
}

function record(value: unknown, source: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, source: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${source} must be a string`);
  return value.trim() || undefined;
}

function stringList(value: unknown, source: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${source} must be a list of strings`);
  }
  return value as string[];
}

function splitList(value: string | undefined): string[] {
  return (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
}
