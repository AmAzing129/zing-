import type { TriggerInfo } from "./plugin/types";

export const MESSAGE_TRIGGER: TriggerInfo = Object.freeze({ kind: "message" });

const TRIGGER_KIND = /^[a-z][a-z0-9_-]{0,31}$/;
const TRIGGER_SOURCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export function normalizeTriggerInfo(info: TriggerInfo | undefined, senderId: string | undefined): TriggerInfo {
  if (!info) {
    return MESSAGE_TRIGGER;
  }
  const kind = info.kind.trim();
  if (!TRIGGER_KIND.test(kind)) {
    throw new Error(`Invalid trigger kind: ${JSON.stringify(info.kind)}. Use 1-32 lowercase letters, digits, "_" or "-".`);
  }
  const source = info.source?.trim() || undefined;
  if (source !== undefined && !TRIGGER_SOURCE.test(source)) {
    throw new Error(`Invalid trigger source: ${JSON.stringify(info.source)}`);
  }
  if (kind !== "message" && senderId !== undefined) {
    throw new Error(`A ${kind} trigger cannot carry a senderId; only message triggers come from a human sender.`);
  }
  return source === undefined ? (kind === "message" ? MESSAGE_TRIGGER : { kind }) : { kind, source };
}

export function isMessageTrigger(info: TriggerInfo): boolean {
  return info.kind === "message";
}

/**
 * The model-facing text of a trigger. A message is the user's own words; any other kind is framed so the
 * model knows nobody typed it. Rendering is deterministic so reloaded history matches the original turn.
 */
export function renderTriggerText(info: TriggerInfo, text: string, at: number): string {
  if (isMessageTrigger(info)) {
    return text;
  }
  const source = info.source ? ` source=${info.source}` : "";
  const time = Number.isFinite(at) ? ` at=${new Date(at).toISOString()}` : "";
  return `[trigger kind=${info.kind}${source}${time}; automated event, not typed by the user]\n${text}`;
}
