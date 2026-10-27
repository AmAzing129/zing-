import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";

import type { McpServer } from "./servers";

/** What mcp-connect stored for one server. Credentials are the Station's, not the Capsule's. */
type Stored = {
  v: 1;
  /** The server the credentials were issued for. A changed URL ignores them. */
  url: string;
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  discovery?: OAuthDiscoveryState;
};

/** What the authorization server sent back to the redirect URL. */
export type Callback = { code: string; iss?: string };

/** $ZING_HOME/connections/mcp/<alias>.json, readable only by the station's user. */
export function credentialsPath(home: string, alias: string): string {
  return join(home, "connections", "mcp", `${alias}.json`);
}

/**
 * OAuth for one MCP server, backed by its credentials file. The station refreshes tokens with it but never starts
 * an interactive authorization: it records the need, and the connection fails with a message naming mcp-connect.
 */
export class FileOAuthProvider implements OAuthClientProvider {
  readonly #server: McpServer;
  readonly #path: string;
  readonly #onAuthorize: ((url: URL) => void | Promise<void>) | undefined;
  #stored: Stored;
  #verifier: string | undefined;
  #state: string | undefined;
  /** Set when the server needs an authorization the station cannot complete by itself. */
  authorizationRequired = false;

  private constructor(server: McpServer, path: string, stored: Stored, onAuthorize?: (url: URL) => void | Promise<void>) {
    this.#server = server;
    this.#path = path;
    this.#stored = stored;
    this.#onAuthorize = onAuthorize;
  }

  /** onAuthorize is the interactive step: without it, an authorization request only sets authorizationRequired. */
  static async open(
    server: McpServer,
    path: string,
    onAuthorize?: (url: URL) => void | Promise<void>,
  ): Promise<FileOAuthProvider> {
    return new FileOAuthProvider(server, path, await readStored(path, server.url.href), onAuthorize);
  }

  get redirectUrl(): string {
    return `http://localhost:${this.#server.oauth.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    const scope = this.#server.oauth.scopes?.join(" ");
    return {
      client_name: "Zing",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(scope ? { scope } : {}),
    };
  }

  /** The state sent with the last authorization request, to check on the callback. */
  get expectedState(): string | undefined {
    return this.#state;
  }

  state(): string {
    this.#state = randomBytes(16).toString("base64url");
    return this.#state;
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    const { clientId, clientSecret } = this.#server.oauth;
    if (clientId) return { client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) };
    return this.#stored.client;
  }

  async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    await this.#save({ ...this.#stored, client });
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.#stored.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    await this.#save({ ...this.#stored, tokens });
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    if (!this.#onAuthorize) {
      this.authorizationRequired = true;
      return;
    }
    await this.#onAuthorize(url);
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.#verifier) throw new Error(`No authorization in progress for MCP server ${this.#server.alias}`);
    return this.#verifier;
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.#save({ ...this.#stored, discovery });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#stored.discovery;
  }

  async validateResourceURL(): Promise<URL | undefined> {
    // Some servers protect a resource other than their endpoint, such as https://mcp.notion.com for /mcp.
    const resource = this.#server.oauth.resource;
    return resource ? new URL(resource) : undefined;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "verifier") {
      this.#verifier = undefined;
      return;
    }
    const next: Stored = { ...this.#stored };
    if (scope === "all" || scope === "client") delete next.client;
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "discovery") delete next.discovery;
    await this.#save(next);
  }

  async #save(next: Stored): Promise<void> {
    this.#stored = next;
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

/** Read the redirect address. Its state must be the one this authorization sent. */
export function parseCallback(url: URL, state: string): Callback {
  const params = url.searchParams;
  if (params.get("state") !== state) {
    throw new Error("The address's state does not match this authorization; use the newest link.");
  }
  const error = params.get("error");
  if (error) {
    throw new Error(`Authorization failed: ${params.get("error_description") ?? error}`);
  }
  const code = params.get("code");
  if (!code) throw new Error("The address has no authorization code");
  const iss = params.get("iss");
  return { code, ...(iss ? { iss } : {}) };
}

async function readStored(path: string, url: string): Promise<Stored> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isEnoent(error)) return { v: 1, url };
    throw new Error(`MCP credentials ${path} are unreadable`, { cause: error });
  }
  const stored = raw as Partial<Stored> | null;
  if (!stored || stored.v !== 1 || stored.url !== url) {
    // Issued for another server or format: start over rather than send them somewhere else.
    return { v: 1, url };
  }
  return stored as Stored;
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
