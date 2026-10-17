/**
 * Authorize the station with MCP servers that use OAuth, then list the Zing names of their tools.
 *
 *   ./node_modules/.bin/tsx plugins/tools/mcp/connect.ts                      the MCP_URL server
 *   ./node_modules/.bin/tsx plugins/tools/mcp/connect.ts <bundle> [server]    a bundle's servers
 *
 * Open the printed URL in a browser. It returns to http://localhost:<port>/callback; when the station runs on
 * another machine or in a container, paste the address the browser ends on instead. Credentials are written to
 * $ZING_HOME/connections/mcp/<server>.json for the station to use and refresh.
 */
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";

import { loadBundle, zingHome } from "zing";

import { authorize } from "./authorize";
import { connectServer } from "./index";
import { parseCallback, type Callback } from "./oauth";
import { bundleServers, envServer, localToolName, type McpServer } from "./servers";

async function main(argv: string[]): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const env = process.env;
  const [bundlePath, only, ...rest] = argv;
  if (rest.length > 0 || bundlePath === "--help" || bundlePath === "-h") {
    console.log("Usage: connect.ts [<bundle> [server]]");
    return;
  }
  let servers: McpServer[];
  if (bundlePath) {
    const bundle = await loadBundle(bundlePath);
    servers = (await bundleServers(bundle, env)).filter((server) => !only || server.alias === only);
    if (servers.length === 0) {
      throw new Error(`Bundle ${bundle.name} has no remote MCP server${only ? ` ${only}` : "s"}`);
    }
  } else {
    const server = envServer(env);
    if (!server) throw new Error("Set MCP_URL, or pass the path of a bundle");
    servers = [server];
  }

  const home = zingHome(env);
  for (const server of servers) {
    await authorize(server, home, (url, redirectUrl, state) => receive(server, url, redirectUrl, state));
    const connection = await connectServer(server, home);
    try {
      const names = connection.tools.map((tool) => localToolName(server, tool.name));
      console.log(`\n${server.alias}: connected. Allow the tools you want in agent.yaml:`);
      for (const name of names) console.log(`  - ${name}`);
    } finally {
      await connection.close();
    }
  }
}

/** Listen for the browser first, then print the authorization URL and wait for it to come back. */
async function receive(server: McpServer, authorizationUrl: URL, redirectUrl: string, state: string): Promise<Callback> {
  const listeners = await listen(server.oauth.callbackPort);
  console.log(`\nAuthorize ${server.alias} by opening:\n\n  ${authorizationUrl.href}\n`);
  console.log(
    listeners.length > 0
      ? `Waiting for ${redirectUrl}. Or paste the address the browser ends on and press Enter.`
      : "Then paste the address the browser ends on and press Enter.",
  );
  return waitForCallback(listeners, state);
}

/** Listeners for the redirect on both loopback addresses, since localhost may resolve to either. */
async function listen(port: number): Promise<Server[]> {
  const attempts = ["127.0.0.1", "::1"].map(
    (host) =>
      new Promise<Server | undefined>((resolve) => {
        const server = createServer();
        server.once("listening", () => resolve(server));
        server.once("error", () => resolve(undefined));
        server.listen(port, host);
      }),
  );
  const listeners = (await Promise.all(attempts)).filter((server) => server !== undefined);
  if (listeners.length === 0) console.log(`Cannot listen on localhost:${port}.`);
  return listeners;
}

/** The first valid callback from the listener or from a pasted address. */
function waitForCallback(listeners: readonly Server[], state: string): Promise<Callback> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin });
    const finish = (outcome: { callback: Callback } | { error: Error }): void => {
      lines.close();
      for (const listener of listeners) listener.close();
      if ("callback" in outcome) resolve(outcome.callback);
      else reject(outcome.error);
    };
    const accept = (url: URL): string => {
      try {
        const callback = parseCallback(url, state);
        finish({ callback });
        return "Zing is connected. You can close this tab.";
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!/state does not match/.test(failure.message)) finish({ error: failure });
        return failure.message;
      }
    };

    lines.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        console.log("Paste the whole address, starting with http://localhost.");
        return;
      }
      const message = accept(url);
      if (!message.startsWith("Zing is connected")) console.log(message);
    });

    for (const listener of listeners) {
      listener.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== "/callback") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end(accept(url));
      });
    }
  });
}

main(process.argv.slice(2)).then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
