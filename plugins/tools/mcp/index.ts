import {
  Client,
  isInputRequiredResult,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type JSONValue,
} from "@modelcontextprotocol/client";
import type { ZingPlugin } from "zing";

const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const REQUEST_TIMEOUT_MS = 60_000;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_PART = /^[a-z][a-z0-9_]*$/;

const mcp: ZingPlugin = async (zing) => {
  const url = parseUrl(zing.requireEnv("MCP_URL"));
  const serverAlias = zing.requireEnv("MCP_SERVER_ALIAS").trim();
  if (!TOOL_PART.test(serverAlias)) {
    throw new Error(
      "MCP_SERVER_ALIAS must start with a lowercase letter and contain only lowercase letters, digits, or underscores",
    );
  }
  const aliases = parseToolAliases(zing.env.MCP_TOOL_ALIASES);
  const protocolVersion = parseProtocolVersion(zing.env.MCP_PROTOCOL_VERSION);
  const token = zing.env.MCP_BEARER_TOKEN?.trim();
  const client = new Client(
    { name: "zing", version: "0.1.0" },
    {
      capabilities: {},
      supportedProtocolVersions: [protocolVersion],
      versionNegotiation:
        protocolVersion === MODERN_PROTOCOL_VERSION
          ? { mode: { pin: MODERN_PROTOCOL_VERSION } }
          : { mode: "legacy" },
      inputRequired: { autoFulfill: false },
    },
  );
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider: token ? { token: async () => token } : undefined,
  });

  try {
    await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    if (
      protocolVersion === MODERN_PROTOCOL_VERSION &&
      (client.getProtocolEra() !== "modern" ||
        client.getNegotiatedProtocolVersion() !== MODERN_PROTOCOL_VERSION)
    ) {
      throw new Error(`MCP server did not negotiate required protocol ${MODERN_PROTOCOL_VERSION}`);
    }

    const remoteTools = (await client.listTools(undefined, { timeout: REQUEST_TIMEOUT_MS })).tools;
    const remoteNames = new Set(remoteTools.map((tool) => tool.name));
    const unusedAliases = Object.keys(aliases).filter((name) => !remoteNames.has(name));
    if (unusedAliases.length > 0) {
      throw new Error(`MCP_TOOL_ALIASES names tools the server did not expose: ${unusedAliases.join(", ")}`);
    }

    const discovered = remoteTools.map((tool) => ({
      remote: tool,
      localName: localToolName(serverAlias, tool.name, aliases),
    }));
    const localNames = new Set<string>();
    for (const tool of discovered) {
      if (localNames.has(tool.localName)) {
        throw new Error(`MCP tools map to the same local name: ${tool.localName}`);
      }
      localNames.add(tool.localName);
    }

    for (const { remote, localName } of discovered) {
      zing.registerTool({
        name: localName,
        description: remote.description?.trim() || `MCP tool ${remote.name} from ${serverAlias}`,
        parameters: remote.inputSchema,
        execute: async (input, { signal }) => {
          const raw: unknown = await client.callTool(
            { name: remote.name, arguments: input },
            {
              signal,
              timeout: REQUEST_TIMEOUT_MS,
              maxTotalTimeout: REQUEST_TIMEOUT_MS,
              allowInputRequired: true,
              toolDefinition: remote,
            },
          );
          if (isInputRequiredResult(raw)) {
            throw new Error(
              `${localName} requires interactive input, which this non-interactive MCP plugin does not support`,
            );
          }
          const result = raw as CallToolResult;
          const text = resultText(result);
          if (result.isError) {
            throw new Error(text || `${localName} failed`);
          }
          return { text, details: JSON.parse(JSON.stringify(result)) as JSONValue };
        },
      });
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  return async () => {
    if (closed) {
      return;
    }
    closed = true;
    try {
      await transport.terminateSession();
    } finally {
      await client.close();
    }
  };
};

export default mcp;

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

export function localToolName(
  serverAlias: string,
  remoteName: string,
  aliases: Readonly<Record<string, string>>,
): string {
  const toolAlias = aliases[remoteName] ?? remoteName;
  if (!TOOL_PART.test(toolAlias)) {
    throw new Error(`MCP tool ${remoteName} needs an explicit alias in MCP_TOOL_ALIASES`);
  }
  const name = `${serverAlias}__${toolAlias}`;
  if (!TOOL_NAME.test(name)) {
    throw new Error(`MCP tool name is invalid or longer than 64 characters: ${name}`);
  }
  return name;
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

function parseProtocolVersion(value: string | undefined): string {
  const version = value?.trim() || MODERN_PROTOCOL_VERSION;
  if (version !== MODERN_PROTOCOL_VERSION && version !== LEGACY_PROTOCOL_VERSION) {
    throw new Error(
      `MCP_PROTOCOL_VERSION must be ${MODERN_PROTOCOL_VERSION} or the explicit compatibility version ${LEGACY_PROTOCOL_VERSION}`,
    );
  }
  return version;
}

function parseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error("MCP_URL must be a valid URL", { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("MCP_URL must use http or https");
  }
  return url;
}
