import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ApiKeyAuth, OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";

/** Refresh this long before expiry so a token never lapses mid-turn. */
const MIN_VALIDITY_MS = 5 * 60 * 1000;
/** A refresh rotates the refresh token, so it is never canceled by a turn; only bounded. */
const REFRESH_TIMEOUT_MS = 15_000;

export const LOGIN_HINT = "npx tsx plugins/providers/openai-codex/login.ts";

export function codexAuthFile(env: NodeJS.ProcessEnv): string {
  const home = env.ZING_HOME?.trim() || join(homedir(), ".zing");
  return env.OPENAI_CODEX_AUTH_FILE?.trim() || join(home, "auth", "openai-codex.json");
}

export async function loadCredential(path: string): Promise<OAuthCredential | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const value = JSON.parse(text) as Partial<OAuthCredential>;
  if (
    value.type !== "oauth" ||
    typeof value.access !== "string" ||
    typeof value.refresh !== "string" ||
    typeof value.expires !== "number"
  ) {
    throw new Error(`Invalid OpenAI Codex credential in ${path}. Sign in again: ${LOGIN_HINT}`);
  }
  return value as OAuthCredential;
}

export async function saveCredential(path: string, credential: OAuthCredential): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

/**
 * Request auth backed by a ChatGPT (Codex) sign-in stored in a file, refreshed in place. The file is read on every
 * request, so a new sign-in or a sign-out applies to the next one.
 */
export function fileOAuthAuth(oauth: OAuthAuth, path: string): ApiKeyAuth {
  let refreshing: Promise<OAuthCredential> | undefined;

  const fresh = (credential: OAuthCredential) => Date.now() < credential.expires - MIN_VALIDITY_MS;

  const refresh = async (): Promise<OAuthCredential> => {
    // Re-read under the single flight: a concurrent refresh or a new sign-in may already have replaced the file.
    const stored = await loadCredential(path);
    if (!stored) throw new Error(`Not signed in to OpenAI Codex. Run: ${LOGIN_HINT}`);
    if (fresh(stored)) return stored;
    const next = await oauth.refresh(stored, AbortSignal.timeout(REFRESH_TIMEOUT_MS)).catch((error: unknown) => {
      throw new Error(`OpenAI Codex token refresh failed; sign in again with ${LOGIN_HINT}`, { cause: error });
    });
    // Save only if the file still holds the credential just refreshed: a sign-in or sign-out during the refresh wins.
    const current = await loadCredential(path);
    if (!current) throw new Error(`Not signed in to OpenAI Codex. Run: ${LOGIN_HINT}`);
    if (current.refresh !== stored.refresh) return fresh(current) ? current : refresh();
    await saveCredential(path, next);
    return next;
  };

  return {
    name: "OpenAI Codex (ChatGPT sign-in)",
    resolve: async ({ signal }) => {
      signal.throwIfAborted();
      const stored = await loadCredential(path);
      if (!stored) throw new Error(`Not signed in to OpenAI Codex. Run: ${LOGIN_HINT}`);
      let credential = stored;
      if (!fresh(credential)) {
        refreshing ??= refresh().finally(() => {
          refreshing = undefined;
        });
        credential = await refreshing;
      }
      const auth = await oauth.toAuth(credential);
      return { auth, source: path };
    },
  };
}
