import type { ThreadEntry } from "zing";

export type MemoryOrigin = "owner" | "agent" | "untrusted" | "system";
export type MemoryRecallHit = { text: string; source?: string; origin?: MemoryOrigin; score?: number };

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const REMEMBER = /remember(?: that)?|don't forget|记住|别忘了|记一下/i;
const URL_ONLY = /^https?:\/\/\S+$/i;
const HEADING = /^## (\d{4}-\d{2}-\d{2})\s*$/;
const BULLET = /^- (?:\[(owner|agent|untrusted|system)\] )?(.+)$/;
const DEDUP_MS = 3_600_000;

export function collapse(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

export function normalize(text: string): string {
  return collapse(text).toLowerCase();
}

export function extractNote(text: string): string | undefined {
  const collapsed = collapse(text);
  if (!collapsed || URL_ONLY.test(collapsed)) {
    return undefined;
  }
  const remembered = REMEMBER.test(collapsed);
  const declarative = !/[?？]/.test(collapsed) && normalize(collapsed).length >= 40;
  if (!remembered && !declarative) {
    return undefined;
  }
  return collapsed.length > 280 ? collapsed.slice(0, 280) : collapsed;
}

export function utcDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function appendBullet(markdown: string, date: string, bullet: string): string {
  const heading = `## ${date}`;
  const line = `- ${bullet}`;
  const body = markdown.replace(/\s*$/, "");
  const headings = [...body.matchAll(/^## (\d{4}-\d{2}-\d{2})\s*$/gm)];
  const last = headings.at(-1);
  if (last?.[1] === date) {
    return `${body}\n${line}\n`;
  }
  return `${body}${body ? "\n\n" : ""}${heading}\n\n${line}\n`;
}

export type ParsedBullet = {
  date: string;
  text: string;
  origin?: MemoryOrigin;
};

export function parseBullets(markdown: string): ParsedBullet[] {
  let date = "";
  const bullets: ParsedBullet[] = [];
  for (const line of markdown.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading?.[1]) {
      date = heading[1];
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet?.[2]) {
      bullets.push({
        date,
        text: bullet[2],
        origin: bullet[1] as MemoryOrigin | undefined,
      });
    }
  }
  return bullets;
}

export function scoreText(text: string, query: string): number {
  const hay = text.toLowerCase();
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return 0;
  let score = hay.includes(normalizedQuery) ? 1 : 0;
  for (const token of tokenize(normalizedQuery)) {
    if (hay.includes(token)) {
      score += 1;
    }
  }
  return score;
}

export function tokenize(text: string): string[] {
  return [...new Set([...segmenter.segment(text)].filter((part) => part.isWordLike).map((part) => part.segment.toLowerCase()))];
}

export function entryText(entry: ThreadEntry): string {
  if (typeof entry.content === "string") return entry.content;
  return entry.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

export function rankNotes(markdown: string, query: string, limit: number): MemoryRecallHit[] {
  return parseBullets(markdown)
    .map((bullet, index) => ({
      text: bullet.text,
      source: bullet.date || undefined,
      origin: bullet.origin,
      score: scoreText(`${bullet.date} ${bullet.text}`, query),
      index,
    }))
    .filter((hit) => (hit.score ?? 0) > 0)
    .sort(
      (left, right) =>
        (right.score ?? 0) - (left.score ?? 0) || (right.source ?? "").localeCompare(left.source ?? "") || left.index - right.index,
    )
    .slice(0, limit)
    .map(({ index: _index, ...hit }) => hit);
}

export type RecentMap = Record<string, number>;

export function shouldSkipDuplicate(recent: RecentMap, conversationId: string, normalized: string, at: number): boolean {
  const previous = recent[`${conversationId}\0${normalized}`];
  return previous !== undefined && at - previous < DEDUP_MS;
}

export function rememberRecent(recent: RecentMap, conversationId: string, normalized: string, at: number): RecentMap {
  return { ...recent, [`${conversationId}\0${normalized}`]: at };
}
