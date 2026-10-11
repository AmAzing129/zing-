import assert from "node:assert/strict";
import test from "node:test";

import { fauxProvider } from "@earendil-works/pi-ai";

import { createStation } from "../src/station";

function wrap(faux: ReturnType<typeof fauxProvider>, pluginId = faux.provider.id) {
  return { pluginId, provider: faux.provider, getApiKey: () => `${pluginId}-key` };
}

test("createStation resolves a model id without naming the provider", () => {
  const xai = fauxProvider({ provider: "xai", models: [{ id: "grok-4.6" }] });
  const station = createStation({ providers: [wrap(xai, "xai")] });
  assert.equal(station.resolveModel("grok-4.6").id, "grok-4.6");
  assert.equal(station.resolveModel("grok-4.6").provider, "xai");
});

test("createStation rejects a model id outside the provider catalogs", () => {
  const xai = fauxProvider({ provider: "xai", models: [{ id: "grok-4.6" }, { id: "grok-4.5" }] });
  const other = fauxProvider({ provider: "other", models: [{ id: "other-1" }] });
  const station = createStation({ providers: [wrap(xai, "xai")] });
  assert.throws(() => station.resolveModel("grok-4.66"), /^Error: Unknown model: grok-4\.66\. Available: xai \(grok-4\.6, grok-4\.5\)$/);
  const preferred = createStation({ providers: [wrap(xai, "xai"), wrap(other, "other")], provider: "other" });
  assert.throws(() => preferred.resolveModel("grok-4.6"), /^Error: Unknown model: grok-4\.6 on provider other\. Available: other \(other-1\)$/);
});

test("createStation picks the provider that owns the model id", () => {
  const xai = fauxProvider({ provider: "xai", models: [{ id: "grok-4.6" }] });
  const anthropic = fauxProvider({ provider: "anthropic", models: [{ id: "claude-opus-4" }] });
  const station = createStation({ providers: [wrap(xai, "xai"), wrap(anthropic, "anthropic")] });
  assert.equal(station.resolveModel("claude-opus-4").provider, "anthropic");
  assert.equal(station.resolveModel("grok-4.6").provider, "xai");
});

test("createStation requires --provider when two plugins serve the same id", () => {
  const left = fauxProvider({ provider: "left", models: [{ id: "shared" }] });
  const right = fauxProvider({ provider: "right", models: [{ id: "shared" }] });
  const providers = [wrap(left, "left"), wrap(right, "right")];
  assert.throws(() => createStation({ providers }).resolveModel("shared"), /multiple providers/);
  assert.equal(createStation({ providers, provider: "right" }).resolveModel("shared").provider, "right");
});

test("createStation routes getApiKey to the owning plugin", () => {
  const xai = fauxProvider({ provider: "xai", models: [{ id: "grok-4.6" }] });
  const station = createStation({ providers: [wrap(xai, "xai")] });
  assert.equal(station.getApiKey("xai"), "xai-key");
});

test("createStation rejects an empty or unknown preferred provider", () => {
  assert.throws(() => createStation({ providers: [] }), /No provider plugin loaded/);
  const xai = fauxProvider({ provider: "xai", models: [{ id: "grok-4.6" }] });
  assert.throws(() => createStation({ providers: [wrap(xai, "xai")], provider: "openai" }), /Unknown provider/);
});
