import { fileURLToPath } from "node:url";

import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type CallToolResult,
  type ClientOptions,
  type JSONValue,
  type Tool as RemoteTool,
} from "@modelcontextprotocol/client";
import { zingHome, type ZingPlugin, type ZingPluginAPI } from "zing";

import { credentialsPath, FileOAuthProvider } from "./oauth";
import {
  configuredServers,
  describeOrigin,
  LEGACY_PROTOCOL_VERSION,
  localToolName,
  MODERN_PROTOCOL_VERSION,
  type McpServer,
} from "./servers";

export { derivedPart, localToolName, parseToolAliases } from "./servers";

const REQUEST_TIMEOUT_MS = 60_000;
/** MCP Apps: interactive views that a client renders for a tool's results. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
export const UI_MIME_TYPE = "text/html;profile=mcp-app";

/** The server needs an authorization that only mcp-connect can complete. */
export class AuthorizationRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuthorizationRequiredError";
  }
}

/** One connected server and the tools it listed at startup. */
export type Connection = {
  server: McpServer;
  client: Client;
  tools: RemoteTool[];
  close: () => Promise<void>;
};

export type ConnectOptions = {
  /** Tell the server this station's clients render MCP Apps. */
  apps?: boolean;
  /** The interactive authorization step (mcp-connect). Without it, a server that needs one fails with its command. */
  onAuthorize?: (url: URL) => void | Promise<void>;
};

const mcp: ZingPlugin = async (zing) => {
  const servers = await configuredServers(zing.env, zing.bundles);
  if (servers.length === 0) {
    throw new Error(
      "No MCP server configured. Set MCP_URL, or list a bundle with remote MCP servers under bundles in station.yaml.",
    );
  }
  const home = zingHome(zing.env);
  const apps = parseApps(zing.env.MCP_APPS);
  const settled = await Promise.allSettled(servers.map((server) => connectServer(server, home, { apps })));
  const connections = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failures = settled.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= closeAll(connections);
    return closing;
  };

  try {
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `${failures.length} MCP servers failed to connect`);
    const localNames = new Set<string>();
    for (const connection of connections) {
      for (const remote of connection.tools) {
        // A tool only its app may call stays out of the model's tools.
        if (!toolVisibility(remote).model) continue;
        const name = localToolName(connection.server, remote.name);
        if (localNames.has(name)) {
          throw new Error(`MCP tools map to the same local name: ${name}`);
        }
        localNames.add(name);
        zing.registerTool({
          name,
          description: remote.description?.trim() || `MCP tool ${remote.name} from ${connection.server.alias}`,
          parameters: remote.inputSchema,
          // A hint from the server: it decides which calls the approval: writes policy lets through unasked.
          readOnly: remote.annotations?.readOnlyHint === true,
          execute: (input, { signal }) => callTool(connection, remote, name, input, signal),
        });
      }
    }
    registerAppMethods(zing, connections);
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
  return close;
};

export default mcp;

/** Connect and list tools. */
export async function connectServer(server: McpServer, home: string, options: ConnectOptions = {}): Promise<Connection> {
  const oauth = server.bearerToken
    ? undefined
    : await FileOAuthProvider.open(server, credentialsPath(home, server.alias), options.onAuthorize);
  const token = server.bearerToken;
  const capabilities = options.apps ? { extensions: { [UI_EXTENSION]: { mimeTypes: [UI_MIME_TYPE] } } } : {};
  const client = new Client(
    { name: "zing", version: "0.1.0" },
    { capabilities, ...protocolOptions(server), inputRequired: { autoFulfill: false } },
  );
  const transport = new StreamableHTTPClientTransport(server.url, {
    authProvider: token ? { token: async () => token } : oauth,
    ...(Object.keys(server.headers).length > 0 ? { requestInit: { headers: server.headers } } : {}),
  });
  const close = async (): Promise<void> => {
    try {
      await transport.terminateSession();
    } finally {
      await client.close();
    }
  };

  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    if (
      server.protocol === "modern" &&
      (client.getProtocolEra() !== "modern" || client.getNegotiatedProtocolVersion() !== MODERN_PROTOCOL_VERSION)
    ) {
      throw new Error(`MCP server did not negotiate required protocol ${MODERN_PROTOCOL_VERSION}`);
    }
    const tools: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: REQUEST_TIMEOUT_MS });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return { server, client, tools, close };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw explainConnectError(server, error, oauth?.authorizationRequired === true);
  }
}

/** The command that authorizes a server, shown when the station cannot. */
export function connectCommand(server: McpServer): string {
  const script = fileURLToPath(new URL("./connect.ts", import.meta.url));
  return ["./node_modules/.bin/tsx", script, ...(server.bundle ? [server.bundle.dir, server.alias] : [])].join(" ");
}

function explainConnectError(server: McpServer, error: unknown, authorizationRequired: boolean): Error {
  const where = `MCP server ${server.alias} (${describeOrigin(server)})`;
  if (server.bearerToken && error instanceof UnauthorizedError) {
    return new Error(`${where} rejected its configured token`, { cause: error });
  }
  if (authorizationRequired || error instanceof UnauthorizedError) {
    return new AuthorizationRequiredError(`${where} needs authorization. Run: ${connectCommand(server)}`, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (server.protocol === "modern" && server.bundle && /protocol|version|discover/i.test(message)) {
    return new Error(
      `${where} failed to connect with protocol ${MODERN_PROTOCOL_VERSION}: ${message}. ` +
        `If it only speaks ${LEGACY_PROTOCOL_VERSION}, allow that explicitly with MCP_LEGACY_SERVERS=${server.alias}.`,
      { cause: error },
    );
  }
  return new Error(`${where} failed to connect: ${message}`, { cause: error });
}

function protocolOptions(server: McpServer): Pick<ClientOptions, "supportedProtocolVersions" | "versionNegotiation"> {
  switch (server.protocol) {
    case "modern":
      return {
        supportedProtocolVersions: [MODERN_PROTOCOL_VERSION],
        versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
      };
    case "legacy":
      return { supportedProtocolVersions: [LEGACY_PROTOCOL_VERSION], versionNegotiation: { mode: "legacy" } };
    case "fallback":
      return {
        supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
        versionNegotiation: { mode: "auto" },
      };
  }
}

async function callTool(
  connection: Connection,
  remote: RemoteTool,
  localName: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ text: string; details: JSONValue }> {
  const result = await requestTool(connection, remote, localName, input, signal);
  const text = resultText(result);
  if (result.isError) {
    throw new Error(text || `${localName} failed`);
  }
  // The whole result, so a client can hand it to the tool's app.
  return { text, details: toJson(result) };
}

async function requestTool(
  connection: Connection,
  remote: RemoteTool,
  label: string,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<CallToolResult> {
  let raw: unknown;
  try {
    raw = await connection.client.callTool(
      { name: remote.name, arguments: input },
      {
        signal,
        timeout: REQUEST_TIMEOUT_MS,
        maxTotalTimeout: REQUEST_TIMEOUT_MS,
        allowInputRequired: true,
        toolDefinition: remote,
      },
    );
  } catch (error) {
    throw explainRequestError(connection, label, error);
  }
  if (isInputRequiredResult(raw)) {
    throw new Error(`${label} requires interactive input, which this non-interactive MCP plugin does not support`);
  }
  return raw as CallToolResult;
}

function explainRequestError(connection: Connection, label: string, error: unknown): unknown {
  if (error instanceof UnauthorizedError && !connection.server.bearerToken) {
    return new Error(`${label} lost its authorization. Run: ${connectCommand(connection.server)}`, { cause: error });
  }
  return error;
}

/** Who may call a tool, from its _meta.ui.visibility. Without one, both the model and the tool's app may. */
export function toolVisibility(tool: Pick<RemoteTool, "_meta">): { model: boolean; app: boolean } {
  const ui = tool._meta?.ui;
  const visibility = isRecord(ui) && Array.isArray(ui.visibility) ? (ui.visibility as unknown[]) : undefined;
  if (!visibility) return { model: true, app: true };
  return { model: visibility.includes("model"), app: visibility.includes("app") };
}

/**
 * The methods a client needs to render MCP Apps: which tools have an app, the app's ui:// resource, and the calls
 * the app makes to its own server. They act for the user in the client, so blueprint approval does not apply.
 */
function registerAppMethods(zing: ZingPluginAPI, connections: readonly Connection[]): void {
  const byAlias = new Map(connections.map((connection) => [connection.server.alias, connection]));
  const connectionOf = (params: Record<string, unknown>): Connection => {
    const alias = requiredString(params.server, "server");
    const connection = byAlias.get(alias);
    if (!connection) throw new Error(`Unknown MCP server: ${alias}`);
    return connection;
  };

  zing.registerMethod({
    name: "mcp/servers/list",
    handle: async () =>
      toJson({
        servers: connections.map((connection) => ({
          server: connection.server.alias,
          capabilities: connection.client.getServerCapabilities() ?? {},
          tools: connection.tools.map((tool) => ({
            definition: tool,
            ...(toolVisibility(tool).model ? { zingTool: localToolName(connection.server, tool.name) } : {}),
          })),
        })),
      }),
  });

  zing.registerMethod({
    name: "mcp/resources/read",
    handle: async (params, { signal }) => {
      const record = requiredRecord(params);
      const connection = connectionOf(record);
      const uri = requiredString(record.uri, "uri");
      try {
        return toJson(await connection.client.readResource({ uri }, { signal, timeout: REQUEST_TIMEOUT_MS }));
      } catch (error) {
        throw explainRequestError(connection, `Reading ${uri}`, error);
      }
    },
  });

  zing.registerMethod({
    name: "mcp/tools/call",
    handle: async (params, { signal }) => {
      const record = requiredRecord(params);
      const connection = connectionOf(record);
      const name = requiredString(record.name, "name");
      const input = record.arguments === undefined ? {} : requiredRecord(record.arguments, "arguments");
      const remote = connection.tools.find((tool) => tool.name === name);
      if (!remote) throw new Error(`Unknown tool ${name} on MCP server ${connection.server.alias}`);
      if (!toolVisibility(remote).app) {
        throw new Error(`Tool ${name} on MCP server ${connection.server.alias} is not available to apps`);
      }
      // An error result goes back as it is: the app shows it.
      return toJson(await requestTool(connection, remote, name, input, signal));
    },
  });
}

function parseApps(value: string | undefined): boolean {
  const flag = value?.trim() ?? "";
  if (flag === "" || flag === "0") return false;
  if (flag === "1") return true;
  throw new Error("MCP_APPS must be 1 or 0");
}

function requiredRecord(value: unknown, field = "params"): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJson(value: unknown): JSONValue {
  return JSON.parse(JSON.stringify(value)) as JSONValue;
}

async function closeAll(connections: readonly Connection[]): Promise<void> {
  const results = await Promise.allSettled(connections.map((connection) => connection.close()));
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  if (errors.length > 0) throw new AggregateError(errors, "MCP cleanup failed");
}

export function resultText(result: CallToolResult): string {
  const text = result.content
    .filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (text) {
    return text;
  }
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent) ?? "";
  }
  return JSON.stringify(result.content) ?? "";
}
