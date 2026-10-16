import { Type, type JsonValue } from "@earendil-works/pi-ai";
import {
  type CapsuleRef,
  type CapsuleState,
  type ConversationListener,
  type ToolContext,
  type ZingPluginAPI,
} from "zing";

import {
  appendBullet,
  collapse,
  entryText,
  extractNote,
  normalize,
  rankNotes,
  rememberRecent,
  shouldSkipDuplicate,
  utcDate,
  type MemoryOrigin,
  type MemoryRecallHit,
  type RecentMap,
} from "./notes";

export const NOTES_PLUGIN_ID = "notes";
export const MEMORY_DIR = "memory";
const ENGINE_KEY = `${MEMORY_DIR}/ENGINE`;
const NOTES_KEY = `${MEMORY_DIR}/notes.md`;
const CURSOR_KEY = `${MEMORY_DIR}/derived/cursor.json`;
const RECENT_KEY = `${MEMORY_DIR}/derived/recent.json`;
export const MEMORY_SEARCH_TOOL_NAME = "memory_search";
export const MEMORY_SAVE_TOOL_NAME = "memory_save";
export const MEMORY_SEARCH_DESCRIPTION = "Search curated, distilled notes from past conversations and saved facts. This searches memory notes, not raw conversation transcripts.";
export const MEMORY_SAVE_DESCRIPTION = "Save one distilled fact or preference for future conversations. Write it in the user's language as a single sentence.";
export const memorySearchParameters = Type.Object({
  query: Type.String({ minLength: 1, description: "What to look for in curated memory notes." }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum number of notes to return (1-10)." })),
});
export const memorySaveParameters = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 280, description: "One distilled fact or preference, in the user's language, as a single sentence." }),
});

type Store = { notes: string; cursor: Record<string, { at: number }>; recent: RecentMap };
type MutationResult = { writable: boolean; changed: boolean };
const tails = new WeakMap<CapsuleState, Promise<unknown>>();

export type Notes = {
  classify: (senderId?: string) => MemoryOrigin;
  search: (capsule: CapsuleRef, query: string, limit?: number, signal?: AbortSignal) => Promise<MemoryRecallHit[]>;
  save: (capsule: CapsuleRef, conversationId: string, text: string, origin: MemoryOrigin, at?: number, signal?: AbortSignal) => Promise<boolean>;
  observe: ConversationListener;
};

export function createNotes(env: NodeJS.ProcessEnv = process.env): Notes {
  const owners = new Set((env.ZING_MEMORY_OWNER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  const classify = (senderId?: string): MemoryOrigin =>
    owners.size ? (senderId && owners.has(senderId) ? "owner" : "untrusted") : senderId === undefined ? "owner" : "untrusted";

  const enqueue = <T>(capsule: CapsuleRef, run: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const previous = tails.get(capsule.state) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => {
      signal?.throwIfAborted();
      return run();
    });
    tails.set(capsule.state, work);
    void work.finally(() => {
      if (tails.get(capsule.state) === work) tails.delete(capsule.state);
    }).catch(() => undefined);
    return waitForQueued(work, signal);
  };

  const mutate = (capsule: CapsuleRef, run: (store: Store) => boolean, signal?: AbortSignal): Promise<MutationResult> => {
    return enqueue(capsule, async () => {
      const store = await loadStore(capsule.state);
      signal?.throwIfAborted();
      const changed = run(store);
      signal?.throwIfAborted();
      if (!(await engineAllowsWrite(capsule.state, NOTES_PLUGIN_ID))) return { writable: false, changed: false };
      signal?.throwIfAborted();
      // Past this commit point, finish all keys without observing cancellation.
      if (changed) await capsule.state.write(NOTES_KEY, store.notes);
      await capsule.state.write(CURSOR_KEY, `${JSON.stringify(store.cursor, null, 2)}\n`);
      await capsule.state.write(RECENT_KEY, `${JSON.stringify(store.recent, null, 2)}\n`);
      return { writable: true, changed };
    }, signal);
  };

  const add = (store: Store, raw: string, conversationId: string, origin: MemoryOrigin, at: number): boolean => {
    const normalizedRaw = origin === "untrusted" ? raw.replace(/^\s*\[untrusted\]\s*/i, "") : raw;
    const text = collapse(normalizedRaw).slice(0, 280);
    if (!text) return false;
    const key = normalize(text);
    if (shouldSkipDuplicate(store.recent, conversationId, key, at)) return false;
    store.notes = appendBullet(store.notes, utcDate(at), `[${origin}] ${conversationId} — ${text}`);
    store.recent = rememberRecent(store.recent, conversationId, key, at);
    return true;
  };

  return {
    classify,
    async search(capsule, query, limit, signal) {
      signal?.throwIfAborted();
      return enqueue(capsule, async () => {
        const markdown = await capsule.state.read(NOTES_KEY) ?? "";
        signal?.throwIfAborted();
        return rankNotes(markdown, query, clampLimit(limit)).map(frameHit);
      }, signal);
    },
    async save(capsule, conversationId, text, origin, at = Date.now(), signal) {
      signal?.throwIfAborted();
      const result = await mutate(capsule, (store) => add(store, text, conversationId, origin, at), signal);
      if (!result.writable) throw new Error("Memory notes are managed by another engine");
      return result.changed;
    },
    async observe(event, signal) {
      if (event.type !== "turn" || event.entries.length === 0) return;
      const origin = classify(event.senderId);
      await mutate(event.capsule, (store) => {
        let changed = false;
        if (origin === "owner") for (const entry of event.entries) {
          if (entry.type !== "user") continue;
          const note = extractNote(entryText(entry));
          if (note) changed = add(store, note, event.conversationId, "owner", entry.at) || changed;
        }
        store.cursor[event.conversationId] = { at: Math.max(...event.entries.map((entry) => entry.at)) };
        return changed;
      }, signal);
    },
  };
}

export default function notesPlugin(zing: ZingPluginAPI) {
  const notes = createNotes(zing.env);
  zing.registerTool({
    name: MEMORY_SEARCH_TOOL_NAME,
    description: MEMORY_SEARCH_DESCRIPTION,
    parameters: memorySearchParameters,
    readOnly: true,
    async execute(input, context) {
      context.signal.throwIfAborted();
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const results = await notes.search(context.capsule, String(input.query).trim(), limit, context.signal);
      const text = JSON.stringify({ results });
      return { text, details: JSON.parse(text) as JsonValue };
    },
  });
  zing.registerTool({
    name: MEMORY_SAVE_TOOL_NAME,
    description: MEMORY_SAVE_DESCRIPTION,
    parameters: memorySaveParameters,
    async execute(input, context: ToolContext) {
      context.signal.throwIfAborted();
      const text = collapse(String(input.text)).slice(0, 280);
      const origin = notes.classify(context.senderId);
      const saved = await notes.save(context.capsule, context.conversationId, text, origin, undefined, context.signal);
      const details: JsonValue = { saved, origin };
      return { text: saved ? `Saved: ${text}` : `Already remembered: ${text}`, details };
    },
  });
  zing.onConversation(notes.observe);
}

export async function engineAllowsWrite(state: CapsuleState, pluginId: string): Promise<boolean> {
  if (await state.create(ENGINE_KEY, `${pluginId}\n`)) {
    return true;
  }
  const existing = (await state.read(ENGINE_KEY) ?? "").trim();
  if (existing !== pluginId) {
    console.warn(`[memory:${pluginId}] refusing to write; ENGINE is ${existing || "empty"}`);
    return false;
  }
  return true;
}

function waitForQueued<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener("abort", aborted, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function frameHit(hit: MemoryRecallHit): MemoryRecallHit {
  const origin = hit.origin ?? "untrusted";
  return origin === "owner" || origin === "agent" ? hit : { ...hit, text: `[untrusted] ${hit.text}` };
}

function clampLimit(limit?: number): number {
  return Math.max(1, Math.min(10, Math.trunc(limit ?? 5)));
}

async function loadStore(state: CapsuleState): Promise<Store> {
  return {
    notes: await state.read(NOTES_KEY) ?? "",
    cursor: await readJson<Record<string, { at: number }>>(state, CURSOR_KEY),
    recent: await readJson<RecentMap>(state, RECENT_KEY),
  };
}

async function readJson<T extends object>(state: CapsuleState, key: string): Promise<T> {
  const text = await state.read(key) ?? "";
  return text.trim() ? JSON.parse(text) as T : {} as T;
}
