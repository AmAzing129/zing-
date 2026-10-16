import { auth } from "@modelcontextprotocol/client";

import { AuthorizationRequiredError, connectServer } from "./index";
import { credentialsPath, FileOAuthProvider, type Callback } from "./oauth";
import type { McpServer } from "./servers";

/** Show the authorization URL to the user and resolve with what the browser is redirected to. */
export type ReceiveCallback = (authorizationUrl: URL, redirectUrl: string, state: string) => Promise<Callback>;

/**
 * Run the OAuth authorization code flow for one server, unless its stored credentials already work or it needs none.
 * The tokens land in the server's credentials file, where the station reads and refreshes them.
 */
export async function authorize(server: McpServer, home: string, receive: ReceiveCallback): Promise<void> {
  if (server.bearerToken) return;
  try {
    // A refused connection also records discovery from the server's 401 challenge, which the flow below reuses.
    await (await connectServer(server, home)).close();
    return;
  } catch (error) {
    if (!(error instanceof AuthorizationRequiredError)) throw error;
  }

  let authorizationUrl: URL | undefined;
  const provider = await FileOAuthProvider.open(server, credentialsPath(home, server.alias), (url) => {
    authorizationUrl = url;
  });
  const scope = server.oauth.scopes?.join(" ");
  const options = { serverUrl: server.url, ...(scope ? { scope } : {}) };
  let started: Awaited<ReturnType<typeof auth>>;
  try {
    started = await auth(provider, options);
  } catch (error) {
    const variable = server.oauth.clientIdVariable;
    if (!variable) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. The bundle expects a registered OAuth client: set ${variable}.`, { cause: error });
  }
  if (started === "AUTHORIZED") return;
  const state = provider.expectedState;
  if (!authorizationUrl || !state) throw new Error(`MCP server ${server.alias} did not start an authorization`);

  const callback = await receive(authorizationUrl, provider.redirectUrl, state);
  const result = await auth(provider, {
    ...options,
    authorizationCode: callback.code,
    ...(callback.iss ? { iss: callback.iss } : {}),
  });
  if (result !== "AUTHORIZED") throw new Error(`MCP server ${server.alias} did not issue tokens`);
}
