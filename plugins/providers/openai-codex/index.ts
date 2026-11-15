import { existsSync } from "node:fs";

import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { Provider, ZingPluginAPI } from "zing";

import { LOGIN_HINT, codexAuthFile, fileOAuthAuth } from "./auth";

export const OPENAI_CODEX_PLUGIN_ID = "openai-codex";

export default function openaiCodex(zing: ZingPluginAPI) {
  const base = openaiCodexProvider();
  const oauth = base.auth.oauth;
  if (!oauth) throw new Error("openai-codex provider has no OAuth flow");
  const path = codexAuthFile(zing.env);
  if (!existsSync(path)) {
    console.warn(`OpenAI Codex: not signed in (${path} missing). Run: ${LOGIN_HINT}`);
  }
  const provider: Provider = { ...base, auth: { apiKey: fileOAuthAuth(oauth, path) } };
  zing.registerProvider({ pluginId: OPENAI_CODEX_PLUGIN_ID, provider });
  // Reused Codex WebSockets idle for minutes and would hold the process open after the station stops.
  return async () => {
    const { closeOpenAICodexWebSocketSessions } = await import("@earendil-works/pi-ai/api/openai-codex-responses");
    closeOpenAICodexWebSocketSessions();
  };
}
