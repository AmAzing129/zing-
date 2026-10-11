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

test("createStation falls back to a provider template when the id is unknown", () => {
  const xai = fauxProvider({ provider: "xai", models: [{ id: "grok-4.6" }] });
  const station = createStation({ providers: [wrap(xai, "xai")] });
  const resolved = station.resolveModel("custom-id");
  assert.equal(resolved.id, "custom-id");
  assert.equal(resolved.provider, "xai");
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
