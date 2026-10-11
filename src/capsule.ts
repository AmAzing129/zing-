import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type { Blueprint } from "./blueprint";
import { zingHome } from "./env";
import {
  conversationLogPath,
  decodeEvents,
  encodeMessages,
  eventsAfterLastReset,
  formatEvents,
  parseTranscript,
  resetEvent,
  type TranscriptEvent,
} from "./transcript";

export const CAPSULE_SCHEMA_VERSION = 1;

/** This one: identity and life. The same capsule after undock is the same agent. */
export type CapsuleIdentity = {
  agentId: string;
  blueprintName: string;
  createdAt: string;
  schemaVersion: number;
};

/** Opaque plugin-owned state that follows the capsule across storage backends. `create` is atomic. */
export type CapsuleState = {
  read: (key: string) => Promise<string | undefined>;
  write: (key: string, value: string) => Promise<void>;
  create: (key: string, value: string) => Promise<boolean>;
};

export type Capsule = {
  readonly identity: CapsuleIdentity;
  readonly state: CapsuleState;
  ensureConversation: (conversationId: string) => Promise<{ created: boolean }>;
  readConversationEvents: (conversationId: string) => Promise<TranscriptEvent[] | undefined>;
  listConversations: () => Promise<CapsuleConversation[]>;
  loadConversation: (conversationId: string) => Promise<AgentMessage[]>;
  appendConversation: (conversationId: string, messages: readonly AgentMessage[]) => Promise<void>;
  resetConversation: (conversationId: string) => Promise<void>;
};

export type CapsuleConversation = {
  conversationId: string;
  updatedAt: number;
};

export type OpenCapsuleOptions = {
  blueprint: Blueprint;
  path?: string;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export function slugBlueprintName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

export function defaultCapsulePath(blueprintName: string, home = zingHome()): string {
  return join(home, "capsules", slugBlueprintName(blueprintName));
}

export function createAgentId(): string {
  return `agt_${randomUUID().replaceAll("-", "")}`;
}

export function createMemoryCapsule(
  identity: Partial<CapsuleIdentity> & Pick<CapsuleIdentity, "blueprintName"> = { blueprintName: "memory" },
): Capsule {
  const logs = new Map<string, TranscriptEvent[]>();
  const updated = new Map<string, number>();
  const state = createMemoryState();
  const resolved: CapsuleIdentity = {
    agentId: identity.agentId ?? createAgentId(),
    blueprintName: identity.blueprintName,
    createdAt: identity.createdAt ?? new Date().toISOString(),
    schemaVersion: identity.schemaVersion ?? CAPSULE_SCHEMA_VERSION,
  };

  return {
    identity: resolved,
    state,
    async ensureConversation(conversationId) {
      const created = !logs.has(conversationId);
      if (created) {
        logs.set(conversationId, []);
        updated.set(conversationId, Date.now());
      }
      return { created };
    },
    async readConversationEvents(conversationId) {
      const events = logs.get(conversationId);
      return events ? eventsAfterLastReset(events) : undefined;
    },
    async listConversations() {
      return [...logs.keys()].map((conversationId) => ({
        conversationId,
        updatedAt: updated.get(conversationId) ?? 0,
      }));
    },
    async loadConversation(conversationId) {
      return decodeEvents(logs.get(conversationId) ?? []);
    },
    async appendConversation(conversationId, messages) {
      const events = encodeMessages(messages);
      if (events.length === 0) {
        return;
      }
      logs.set(conversationId, [...(logs.get(conversationId) ?? []), ...events]);
      updated.set(conversationId, Date.now());
    },
    async resetConversation(conversationId) {
      logs.set(conversationId, [...(logs.get(conversationId) ?? []), resetEvent()]);
      updated.set(conversationId, Date.now());
    },
  };
}

export async function openFileCapsule(options: OpenCapsuleOptions): Promise<Capsule> {
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? zingHome(options.env);
  const explicit = options.path?.trim();
  const path = explicit ? resolve(cwd, explicit) : defaultCapsulePath(options.blueprint.name, home);

  await mkdir(path, { recursive: true });
  const state = createFileState(path);

  const identityPath = join(path, "identity.json");
  const existing = await readJson(identityPath);
  const identity = existing
    ? parseIdentity(existing, identityPath)
    : {
        agentId: createAgentId(),
        blueprintName: options.blueprint.name,
        createdAt: new Date().toISOString(),
        schemaVersion: CAPSULE_SCHEMA_VERSION,
      };

  if (!existing) {
    await writeJson(identityPath, identity);
  }

  return {
    identity,
    state,
    async ensureConversation(conversationId) {
      const file = conversationLogPath(path, conversationId);
      await mkdir(dirname(file), { recursive: true });
      try {
        await writeFile(file, "", { flag: "wx" });
        return { created: true };
      } catch (error) {
        if (isEexist(error)) {
          return { created: false };
        }
        throw error;
      }
    },
    async readConversationEvents(conversationId) {
      const file = conversationLogPath(path, conversationId);
      const text = await readText(file);
      return text === undefined ? undefined : eventsAfterLastReset(parseTranscript(text, file));
    },
    async listConversations() {
      return listConversationLogs(path);
    },
    async loadConversation(conversationId) {
      const file = conversationLogPath(path, conversationId);
      const text = await readText(file);
      if (text === undefined) {
        return [];
      }
      return decodeEvents(parseTranscript(text, file));
    },
    async appendConversation(conversationId, messages) {
      const events = encodeMessages(messages);
      if (events.length === 0) {
        return;
      }
      const file = conversationLogPath(path, conversationId);
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, formatEvents(events));
    },
    async resetConversation(conversationId) {
      const file = conversationLogPath(path, conversationId);
      await mkdir(dirname(file), { recursive: true });
      await appendFile(file, formatEvents([resetEvent()]));
    },
  };
}

/** @deprecated Use openFileCapsule when selecting the filesystem adapter explicitly. */
export const openCapsule = openFileCapsule;

function createMemoryState(): CapsuleState {
  const values = new Map<string, string>();
  return {
    async read(key) {
      validateStateKey(key);
      return values.get(key);
    },
    async write(key, value) {
      validateStateKey(key);
      values.set(key, value);
    },
    async create(key, value) {
      validateStateKey(key);
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
  };
}

function createFileState(root: string): CapsuleState {
  return {
    async read(key) {
      return readText(statePath(root, key));
    },
    async write(key, value) {
      const path = statePath(root, key);
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(tmp, value);
      await rename(tmp, path);
    },
    async create(key, value) {
      const path = statePath(root, key);
      await mkdir(dirname(path), { recursive: true });
      try {
        await writeFile(path, value, { flag: "wx" });
        return true;
      } catch (error) {
        if (isEexist(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

function statePath(root: string, key: string): string {
  validateStateKey(key);
  return join(root, ...key.split("/"));
}

function validateStateKey(key: string): void {
  const segments = key.split("/");
  if (
    !key ||
    key.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid capsule state key: ${JSON.stringify(key)}`);
  }
}

function parseIdentity(raw: unknown, source: string): CapsuleIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${source}: identity must be a mapping`);
  }
  const record = raw as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error(`${source}: schemaVersion must be a positive integer`);
  }
  if (schemaVersion > CAPSULE_SCHEMA_VERSION) {
    throw new Error(`${source}: unsupported schemaVersion ${schemaVersion}`);
  }
  const blueprintName = optionalName(record.blueprintName) ?? optionalName(record.definitionName);
  if (!blueprintName) {
    throw new Error(`${source}: blueprintName is required`);
  }
  return {
    agentId: requiredString(record.agentId, `${source}: agentId`),
    blueprintName,
    createdAt: requiredString(record.createdAt, `${source}: createdAt`),
    schemaVersion,
  };
}

function requiredString(value: unknown, source: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${source} is required`);
  }
  return value.trim();
}

function optionalName(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  if (text === undefined) {
    return undefined;
  }
  return JSON.parse(text) as unknown;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isEexist(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function listConversationLogs(capsulePath: string): Promise<CapsuleConversation[]> {
  const root = join(capsulePath, "conversations");
  let channels: Dirent[];
  try {
    channels = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) {
      return [];
    }
    throw error;
  }

  const conversations: CapsuleConversation[] = [];
  for (const channelEntry of channels) {
    if (!channelEntry.isDirectory()) {
      continue;
    }
    const channel = decodeSegment(channelEntry.name);
    const channelPath = join(root, channelEntry.name);
    const files = await readdir(channelPath, { withFileTypes: true });
    for (const fileEntry of files) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) {
        continue;
      }
      const localId = decodeSegment(fileEntry.name.slice(0, -".jsonl".length));
      const info = await stat(join(channelPath, fileEntry.name));
      conversations.push({
        conversationId: channel === "misc" ? localId : `${channel}:${localId}`,
        updatedAt: info.mtimeMs,
      });
    }
  }
  return conversations;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
