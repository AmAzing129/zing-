import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { OAuthAuth } from "@earendil-works/pi-ai";

import { fileOAuthAuth, loadCredential, saveCredential } from "../plugins/providers/openai-codex/auth";
import { createPluginRegistry, loadPlugin } from "../src/plugin/index";

test("deepseek plugin loads through its directory entry and serves the default model", async () => {
  const registry = createPluginRegistry({ env: { DEEPSEEK_API_KEY: "ds-secret" } });
  await loadPlugin(registry, fileURLToPath(new URL("../plugins/providers/deepseek", import.meta.url)));
  const entry = registry.getProvider("deepseek");
  assert.equal(entry?.getApiKey?.(), "ds-secret");
  assert.ok(entry?.provider.getModels().some((model) => model.id === "deepseek-v4-pro"));
});

test("openai-codex plugin loads without a sign-in and serves the blueprint model", async () => {
  const home = await mkdtemp(join(tmpdir(), "zing-codex-"));
  const registry = createPluginRegistry({ env: { ZING_HOME: home } });
  await loadPlugin(registry, fileURLToPath(new URL("../plugins/providers/openai-codex", import.meta.url)));
  const entry = registry.getProvider("openai-codex");
  assert.equal(entry?.getApiKey, undefined);
  assert.equal(entry?.provider.auth.oauth, undefined);
  assert.ok(entry?.provider.getModels().some((model) => model.id === "gpt-6.1-sol"));
});

test("openai-codex auth reads the stored sign-in and refreshes it in place before expiry", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "zing-codex-")), "auth", "openai-codex.json");
  let refreshes = 0;
  const oauth: OAuthAuth = {
    name: "fake",
    login: async () => assert.fail("login is not used"),
    refresh: async (credential) => {
      refreshes++;
      return { ...credential, access: `access-${refreshes}`, refresh: `refresh-${refreshes}`, expires: Date.now() + 3_600_000 };
    },
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };
  const auth = fileOAuthAuth(oauth, path);
  const resolve = () => auth.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal });

  await assert.rejects(resolve(), /Not signed in to OpenAI Codex/);

  await saveCredential(path, { type: "oauth", access: "old", refresh: "refresh-0", expires: Date.now() + 60_000 });
  const [first, second] = await Promise.all([resolve(), resolve()]);
  assert.equal(first?.auth.apiKey, "access-1");
  assert.equal(second?.auth.apiKey, "access-1");
  assert.equal(refreshes, 1);
  assert.equal((await loadCredential(path))?.refresh, "refresh-1");
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  assert.equal((await resolve())?.auth.apiKey, "access-1");
  assert.equal(refreshes, 1);
});

test("openai-codex auth applies a new sign-in or a sign-out on the next request", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "zing-codex-")), "openai-codex.json");
  const oauth: OAuthAuth = {
    name: "fake",
    login: async () => assert.fail("login is not used"),
    refresh: async () => assert.fail("fresh credentials are not refreshed"),
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };
  const auth = fileOAuthAuth(oauth, path);
  const resolve = () => auth.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal });
  const expires = Date.now() + 3_600_000;

  await saveCredential(path, { type: "oauth", access: "account-a", refresh: "refresh-a", expires });
  assert.equal((await resolve())?.auth.apiKey, "account-a");
  await saveCredential(path, { type: "oauth", access: "account-b", refresh: "refresh-b", expires });
  assert.equal((await resolve())?.auth.apiKey, "account-b");
  await rm(path);
  await assert.rejects(resolve(), /Not signed in to OpenAI Codex/);
});

test("openai-codex auth keeps a sign-in or sign-out made while a refresh is in flight", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "zing-codex-")), "openai-codex.json");
  let onRefresh: () => Promise<void> = async () => {};
  const oauth: OAuthAuth = {
    name: "fake",
    login: async () => assert.fail("login is not used"),
    refresh: async (credential) => {
      await onRefresh();
      return { ...credential, access: "account-a-refreshed", refresh: "refresh-a-1", expires: Date.now() + 3_600_000 };
    },
    toAuth: async (credential) => ({ apiKey: credential.access }),
  };
  const auth = fileOAuthAuth(oauth, path);
  const resolve = () => auth.resolve({ ctx: { env: async () => undefined, fileExists: async () => false }, signal: new AbortController().signal });
  const stale = { type: "oauth" as const, access: "account-a", refresh: "refresh-a", expires: Date.now() + 60_000 };
  const accountB = { type: "oauth" as const, access: "account-b", refresh: "refresh-b", expires: Date.now() + 3_600_000 };

  await saveCredential(path, stale);
  onRefresh = () => saveCredential(path, accountB);
  assert.equal((await resolve())?.auth.apiKey, "account-b");
  assert.equal((await loadCredential(path))?.refresh, "refresh-b");

  await saveCredential(path, stale);
  onRefresh = () => rm(path);
  await assert.rejects(resolve(), /Not signed in to OpenAI Codex/);
  assert.equal(await loadCredential(path), undefined);
});
