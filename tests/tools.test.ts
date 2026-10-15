import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import brave, {
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  createBraveWebSearch,
} from "../plugins/tools/brave/index";
import { createMemoryCapsule } from "../src/capsule";
import { createPluginRegistry, loadPlugin, type ToolContext } from "../src/plugin/index";

const capsule = createMemoryCapsule({ blueprintName: "tools-test", agentId: "agt_test" });
const capsuleRef = { agentId: capsule.identity.agentId, state: capsule.state };

test("brave registers web_search with its own description", () => {
  const registry = createPluginRegistry();
  brave(registry.api);
  const tool = registry.getTool(WEB_SEARCH_TOOL_NAME);
  assert.equal(tool?.name, "web_search");
  assert.equal(tool?.description, WEB_SEARCH_DESCRIPTION);
});

test("createBraveWebSearch maps provider results", async () => {
  const search = createBraveWebSearch({
    apiKey: "brave-key",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.search.brave.com");
      assert.equal(url.searchParams.get("q"), "zing");
      assert.equal(url.searchParams.get("count"), "3");
      assert.equal((init?.headers as Record<string, string>)["X-Subscription-Token"], "brave-key");
      return new Response(JSON.stringify({ web: { results: [
        { title: "One", url: "https://one.example", description: "first" },
        { title: "Skip", description: "no url" },
      ] } }));
    },
  });
  assert.deepEqual(await search.execute({ query: "zing", maxResults: 3 }), {
    results: [{ title: "One", url: "https://one.example", snippet: "first" }],
  });
});

test("createBraveWebSearch throws on HTTP 429", async () => {
  const search = createBraveWebSearch({ apiKey: "brave-key", fetch: async () => new Response("nope", { status: 429 }) });
  await assert.rejects(() => search.execute({ query: "zing" }), /429/);
});

test("brave plugin loads and registers web_search", async () => {
  const registry = createPluginRegistry();
  await loadPlugin(registry, fileURLToPath(new URL("../plugins/tools/brave", import.meta.url)));
  assert.equal(registry.getTool(WEB_SEARCH_TOOL_NAME)?.name, WEB_SEARCH_TOOL_NAME);
});

test("brave plugin normalizes untrusted input and forwards the abort signal", async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let requestedUrl: URL | undefined;
  let requestedSignal: AbortSignal | null | undefined;
  globalThis.fetch = async (input, init) => {
    requestedUrl = new URL(String(input));
    requestedSignal = init?.signal;
    return new Response(JSON.stringify({ web: { results: [] } }));
  };
  try {
    const registry = createPluginRegistry({ env: { BRAVE_API_KEY: "brave-key" } });
    brave(registry.api);
    const tool = registry.getTool(WEB_SEARCH_TOOL_NAME);
    assert.ok(tool);
    const context: ToolContext = {
      signal: controller.signal,
      conversationId: "test:input-boundary",
      trigger: { kind: "message" },
      capsule: capsuleRef,
    };

    await tool.execute({ query: 42, maxResults: "9" }, context);

    assert.equal(requestedUrl?.searchParams.get("q"), "42");
    assert.equal(requestedUrl?.searchParams.get("count"), "5");
    assert.equal(requestedSignal, controller.signal);

    await tool.execute({ query: "   ", maxResults: null }, context);
    assert.equal(requestedUrl?.searchParams.get("q"), "");
    assert.equal(requestedUrl?.searchParams.get("count"), "5");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("brave resolves BRAVE_API_KEY lazily", async () => {
  const registry = createPluginRegistry({ env: {} });
  brave(registry.api);
  const tool = registry.getTool(WEB_SEARCH_TOOL_NAME);
  assert.ok(tool);
  const context: ToolContext = {
    signal: new AbortController().signal,
    conversationId: "test:1",
    trigger: { kind: "message" },
    capsule: capsuleRef,
  };
  await assert.rejects(() => tool.execute({ query: "zing" }, context), /BRAVE_API_KEY/);
});
