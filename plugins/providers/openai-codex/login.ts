import "dotenv/config";

import { createInterface } from "node:readline/promises";

import type { AuthPrompt } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

import { codexAuthFile, saveCredential } from "./auth";

// Usage: npx tsx plugins/providers/openai-codex/login.ts [--device]
const method = process.argv.includes("--device") ? "device_code" : undefined;
const oauth = openaiCodexProvider().auth.oauth;
if (!oauth) throw new Error("openai-codex provider has no OAuth flow");

const path = codexAuthFile(process.env);
const rl = createInterface({ input: process.stdin, output: process.stdout });
const controller = new AbortController();

async function answer(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    const preset = prompt.options.find((option) => option.id === method);
    if (preset) return preset.id;
    console.log(`\n${prompt.message}`);
    prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
    const choice = prompt.options[Number.parseInt(await rl.question("Enter number: "), 10) - 1];
    if (!choice) throw new Error("Invalid selection");
    return choice.id;
  }
  const hint = prompt.placeholder ? ` (${prompt.placeholder})` : "";
  return rl.question(`${prompt.message}${hint}\n> `, { signal: prompt.signal });
}

try {
  const credential = await oauth.login({
    signal: controller.signal,
    prompt: answer,
    notify: (event) => {
      if (event.type === "auth_url") console.log(`\nOpen this URL in your browser:\n${event.url}\n${event.instructions ?? ""}`);
      else if (event.type === "device_code") console.log(`\nOpen ${event.verificationUri} and enter code: ${event.userCode}`);
      else console.log(event.message);
    },
  });
  await saveCredential(path, credential);
  console.log(`\nSigned in. Credential saved to ${path}`);
} finally {
  rl.close();
}
