import assert from "node:assert/strict";
import test from "node:test";

import type { CallToolResult } from "@modelcontextprotocol/client";

import { localToolName, parseToolAliases, resultText } from "../plugins/tools/mcp/index";

test("MCP tools get stable names without silent rewriting", () => {
  assert.equal(localToolName("market", "quote", {}), "market__quote");
  assert.equal(localToolName("market", "get-quote", { "get-quote": "quote" }), "market__quote");
  assert.throws(() => localToolName("market", "get-quote", {}), /needs an explicit alias/);
  assert.throws(() => localToolName("market", "x".repeat(64), {}), /longer than 64/);
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
