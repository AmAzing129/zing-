import { homedir } from "node:os";
import { join } from "node:path";

export function zingHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZING_HOME?.trim() || join(homedir(), ".zing");
}

export function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
