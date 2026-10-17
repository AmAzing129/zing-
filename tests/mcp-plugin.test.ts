import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/client";

import { authorize } from "../plugins/tools/mcp/authorize";
import { localToolName, parseToolAliases, resultText } from "../plugins/tools/mcp/index";
import { parseCallback } from "../plugins/tools/mcp/oauth";
import { configuredServers, type McpServer } from "../plugins/tools/mcp/servers";
import { loadBundle, type Bundle } from "../src/bundle";
import { createMemoryCapsule } from "../src/capsule";
import { createPluginRegistry, loadPlugins } from "../src/plugin/index";

const explicit = (aliases: Record<string, string> = {}) =>
  ({ alias: "market", naming: { kind: "explicit", aliases } }) as const;
const derived = (alias: string) => ({ alias, naming: { kind: "derived" } }) as const;

async function writeBundle(root: string, name: string, servers: Record<string, unknown>): Promise<Bundle> {
  const dir = join(root, name);
  await mkdir(join(dir, ".codex-plugin"), { recursive: true });
  await writeFile(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name }));
  await writeFile(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  return loadBundle(dir);
}

test("MCP_URL tools keep explicit names; bundle tools derive them without collisions", () => {
  assert.equal(localToolName(explicit(), "quote"), "market__quote");
  assert.equal(localToolName(explicit({ "get-quote": "quote" }), "get-quote"), "market__quote");
  assert.throws(() => localToolName(explicit(), "get-quote"), /needs an explicit alias/);
  assert.throws(() => localToolName(explicit(), "x".repeat(64)), /longer than 64/);

  assert.equal(localToolName(derived("notion"), "notion-create-pages"), "notion__notion_create_pages");
  assert.equal(localToolName(derived("atlassian"), "getJiraIssue"), "atlassian__get_jira_issue");
  // A derived part never contains "__", so the server prefix stays unambiguous.
  assert.equal(localToolName(derived("x"), "a--b__c."), "x__a_b_c");
  assert.throws(() => localToolName(derived("x"), "2fa"), /has no usable name/);
});

test("MCP_TOOL_ALIASES is an explicit JSON mapping", () => {
  assert.deepEqual(parseToolAliases(undefined), {});
  assert.deepEqual(parseToolAliases('{"get-quote":"quote"}'), { "get-quote": "quote" });
  assert.throws(() => parseToolAliases("[]"), /JSON object/);
  assert.throws(() => parseToolAliases('{"get-quote":"Quote"}'), /Invalid MCP tool alias/);
});

test("MCP results prefer text and preserve structured-only output as JSON", () => {
  assert.equal(
    resultText({ content: [{ type: "text", text: "price: 42" }] } as unknown as CallToolResult),
    "price: 42",
  );
  assert.equal(
    resultText({ content: [], structuredContent: { price: 42 } } as unknown as CallToolResult),
    '{"price":42}',
  );
});

test("bundle MCP files yield remote servers with their OAuth settings and explicit legacy approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-mcp-bundles-"));
  const google = await writeBundle(root, "gmail", {
    "gmail-mail": {
      type: "http",
      url: "https://gmail.example/mcp",
      scopes: ["mail.read"],
      oauth: { callback_port: 12798, client_id: "<GMAIL_CLIENT_ID>", client_secret: "<GMAIL_CLIENT_SECRET>" },
      oauth_resource: "https://gmail.example",
    },
    local: { command: "npx", args: ["server"] },
  });
  const notion = await writeBundle(root, "notion", { notion: { type: "http", url: "https://mcp.notion.example/mcp" } });

  const env = { MCP_LEGACY_SERVERS: "notion", GMAIL_CLIENT_ID: "client-1" };
  const [gmail, legacy, ...rest] = await configuredServers(env, [google, notion]);
  assert.equal(rest.length, 0, "a server that runs a local command is not started");
  assert.equal(gmail?.alias, "gmail_mail");
  assert.equal(gmail?.protocol, "modern");
  assert.deepEqual(gmail?.oauth, {
    callbackPort: 12798,
    scopes: ["mail.read"],
    resource: "https://gmail.example",
    clientId: "client-1",
  });
  assert.equal(legacy?.protocol, "fallback");

  // An unset placeholder leaves registration to the server, and names the variable for its error message.
  const [unregistered] = await configuredServers({}, [google]);
  assert.equal(unregistered?.oauth.clientId, undefined);
  assert.equal(unregistered?.oauth.clientIdVariable, "GMAIL_CLIENT_ID");

  await assert.rejects(
    configuredServers({ MCP_URL: "https://other.example/mcp", MCP_SERVER_ALIAS: "notion" }, [notion]),
    /MCP servers from MCP_URL and bundle notion share the tool prefix notion/,
  );
  await assert.rejects(configuredServers({ MCP_LEGACY_SERVERS: "slack" }, [notion]), /not configured: slack/);
});

test("the redirect address must carry this authorization's state", () => {
  const url = (query: string) => new URL(`http://localhost:33418/callback?${query}`);
  assert.deepEqual(parseCallback(url("code=c&state=s&iss=https%3A%2F%2Fas"), "s"), { code: "c", iss: "https://as" });
  assert.throws(() => parseCallback(url("code=c&state=old"), "s"), /state does not match/);
  assert.throws(() => parseCallback(url("error=access_denied&state=s"), "s"), /Authorization failed: access_denied/);
});

test("a bundle's OAuth server is authorized once, then used and refreshed by the station", async (t) => {
  const fake = await startOAuthMcpServer();
  t.after(() => fake.close());
  const root = await mkdtemp(join(tmpdir(), "zing-mcp-oauth-"));
  const home = join(root, "home");
  const bundle = await writeBundle(root, "demo", { "demo-svc": { type: "http", url: `${fake.base}/mcp` } });
  const env = { ZING_HOME: home, MCP_LEGACY_SERVERS: "demo_svc" };

  const unauthorized = createPluginRegistry({ env, bundles: [bundle] });
  await assert.rejects(
    loadPlugins(unauthorized, ["./plugins/tools/mcp"]),
    /demo_svc \(bundle demo\) needs authorization\. Run: .*connect\.ts .*demo demo_svc/,
  );

  const [server] = (await configuredServers(env, [bundle])) as [McpServer];
  await authorize(server, home, async (authorizationUrl, redirectUrl, state) => {
    // The browser: the fake server consents at once and redirects back.
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(`${location.origin}${location.pathname}`, redirectUrl);
    return parseCallback(location, state);
  });

  const registry = createPluginRegistry({ env, bundles: [bundle] });
  const close = await loadPlugins(registry, ["./plugins/tools/mcp"]);
  t.after(close);
  assert.deepEqual(
    registry.listTools().map((tool) => tool.name),
    ["demo_svc__say_hello", "demo_svc__get_thing"],
  );
  const context = {
    signal: new AbortController().signal,
    conversationId: "test",
    capsule: { agentId: "agt_test", state: createMemoryCapsule().state },
  };
  const tool = registry.getTool("demo_svc__say_hello");
  assert.equal((await tool?.execute({ who: "zing" }, context))?.text, "hello zing");

  fake.expireTokens();
  assert.equal((await tool?.execute({ who: "again" }, context))?.text, "hello again");
  assert.equal(fake.refreshes(), 1);
});

test("MCP Apps: app-only tools stay out of the model's tools, and clients reach apps through plugin methods", async (t) => {
  const fake = await startAppsMcpServer();
  t.after(() => fake.close());
  const env = {
    MCP_URL: `${fake.base}/mcp`,
    MCP_SERVER_ALIAS: "shop",
    MCP_BEARER_TOKEN: "secret",
    MCP_PROTOCOL_VERSION: "2025-11-25",
    MCP_APPS: "1",
  };
  const registry = createPluginRegistry({ env });
  const close = await loadPlugins(registry, ["./plugins/tools/mcp"]);
  t.after(close);

  assert.deepEqual(fake.capabilities(), {
    extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
  });
  assert.deepEqual(registry.listTools().map((tool) => tool.name), ["shop__show_cart", "shop__count_items"]);
  const context = {
    signal: new AbortController().signal,
    conversationId: "test",
    capsule: { agentId: "agt_test", state: createMemoryCapsule().state },
  };
  const shown = await registry.getTool("shop__show_cart")?.execute({}, context);
  assert.deepEqual(shown?.details, {
    content: [{ type: "text", text: "show_cart done" }],
    structuredContent: { tool: "show_cart", input: {} },
  });

  const methods = new Map(registry.listMethods().map((method) => [method.name, method]));
  assert.deepEqual([...methods.keys()], ["mcp/servers/list", "mcp/resources/read", "mcp/tools/call"]);
  const call = async (name: string, params: unknown) => {
    const method = methods.get(name);
    assert.ok(method, name);
    return method.handle(params, { signal: new AbortController().signal });
  };

  const listed = (await call("mcp/servers/list", {})) as {
    servers: Array<{ server: string; tools: Array<{ definition: { name: string; _meta?: unknown }; zingTool?: string }> }>;
  };
  assert.deepEqual(
    listed.servers.map((server) => ({
      server: server.server,
      tools: server.tools.map((tool) => [tool.definition.name, tool.zingTool]),
    })),
    [{ server: "shop", tools: [["show_cart", "shop__show_cart"], ["update_cart", undefined], ["count_items", "shop__count_items"]] }],
  );
  assert.deepEqual(listed.servers[0]?.tools[0]?.definition._meta, { ui: { resourceUri: "ui://shop/cart.html" } });

  assert.deepEqual(await call("mcp/resources/read", { server: "shop", uri: "ui://shop/cart.html" }), {
    contents: [{ uri: "ui://shop/cart.html", mimeType: "text/html;profile=mcp-app", text: "<p>cart</p>" }],
  });
  assert.deepEqual(await call("mcp/tools/call", { server: "shop", name: "update_cart", arguments: { sku: "a" } }), {
    content: [{ type: "text", text: "update_cart done" }],
    structuredContent: { tool: "update_cart", input: { sku: "a" } },
  });
  await assert.rejects(
    call("mcp/tools/call", { server: "shop", name: "count_items" }),
    /count_items on MCP server shop is not available to apps/,
  );
  await assert.rejects(call("mcp/tools/call", { server: "other", name: "update_cart" }), /Unknown MCP server: other/);
  await assert.rejects(call("mcp/resources/read", { server: "shop" }), /uri must be a non-empty string/);
});

test("without MCP_APPS the station does not claim to render apps", async (t) => {
  const fake = await startAppsMcpServer();
  t.after(() => fake.close());
  const registry = createPluginRegistry({
    env: { MCP_URL: `${fake.base}/mcp`, MCP_SERVER_ALIAS: "shop", MCP_BEARER_TOKEN: "secret", MCP_PROTOCOL_VERSION: "2025-11-25" },
  });
  t.after(await loadPlugins(registry, ["./plugins/tools/mcp"]));
  assert.deepEqual(fake.capabilities(), {});
});

/** A 2025-11-25 MCP server with an app: a tool with a ui:// view, a tool only the view calls, and one only for the model. */
async function startAppsMcpServer() {
  let capabilities: unknown;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.headers.authorization !== "Bearer secret") return void response.writeHead(401).end();
    if (request.method !== "POST") return void response.writeHead(405).end();
    const message = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
    if (message.id === undefined) return void response.writeHead(202).end();
    const reply = (result: unknown) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    const schema = { type: "object", properties: {} };
    switch (message.method) {
      case "initialize":
        capabilities = message.params?.capabilities;
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "shop", version: "1" },
        });
      case "tools/list":
        return reply({
          tools: [
            { name: "show_cart", inputSchema: schema, _meta: { ui: { resourceUri: "ui://shop/cart.html" } } },
            { name: "update_cart", inputSchema: schema, _meta: { ui: { resourceUri: "ui://shop/cart.html", visibility: ["app"] } } },
            { name: "count_items", inputSchema: schema, _meta: { ui: { visibility: ["model"] } } },
          ],
        });
      case "resources/read":
        return reply({
          contents: [{ uri: message.params?.uri, mimeType: "text/html;profile=mcp-app", text: "<p>cart</p>" }],
        });
      case "tools/call":
        return reply({
          content: [{ type: "text", text: `${String(message.params?.name)} done` }],
          structuredContent: { tool: message.params?.name, input: message.params?.arguments ?? {} },
        });
    }
    return reply({});
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    capabilities: () => capabilities,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** An authorization server and a 2025-11-25 MCP server in one, with PKCE, registration, and refresh. */
async function startOAuthMcpServer() {
  const challenges = new Map<string, string>();
  const valid = new Set<string>();
  let issued = 0;
  let refreshes = 0;
  let base = "";
  const json = (response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(value));
  };
  const read = (request: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => resolve(body));
    });

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const body = await read(request);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return json(response, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json(response, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (url.pathname === "/register") {
      return json(response, 201, { ...(JSON.parse(body) as object), client_id: "demo-client" });
    }
    if (url.pathname === "/authorize") {
      const code = `code-${challenges.size}`;
      challenges.set(code, url.searchParams.get("code_challenge") ?? "");
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: redirect.href }).end();
      return;
    }
    if (url.pathname === "/token") {
      const params = new URLSearchParams(body);
      if (params.get("grant_type") === "refresh_token") {
        refreshes += 1;
        if (params.get("refresh_token") !== "refresh") return json(response, 400, { error: "invalid_grant" });
      } else {
        const verifier = createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
        if (challenges.get(params.get("code") ?? "") !== verifier) return json(response, 400, { error: "invalid_grant" });
      }
      issued += 1;
      valid.add(`access-${issued}`);
      return json(response, 200, { access_token: `access-${issued}`, token_type: "Bearer", refresh_token: "refresh" });
    }
    if (url.pathname !== "/mcp") return void response.writeHead(404).end();
    if (!valid.has(request.headers.authorization?.replace(/^Bearer /, "") ?? "")) {
      return json(response, 401, { error: "unauthorized" }, {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    if (request.method !== "POST") return void response.writeHead(405).end();
    const message = JSON.parse(body) as { id?: number; method: string; params?: { arguments?: { who?: string } } };
    if (message.id === undefined) return void response.writeHead(202).end();
    const reply = (result: unknown) => json(response, 200, { jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize") {
      return reply({ protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "demo", version: "1" } });
    }
    if (message.method === "tools/list") {
      const schema = { type: "object", properties: {} };
      return reply({
        tools: [
          { name: "say-hello", description: "Say hello", inputSchema: schema },
          { name: "getThing", description: "Get a thing", inputSchema: schema },
        ],
      });
    }
    if (message.method === "tools/call") {
      return reply({ content: [{ type: "text", text: `hello ${message.params?.arguments?.who}` }] });
    }
    return json(response, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "localhost", resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    expireTokens: () => valid.clear(),
    refreshes: () => refreshes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
