import { randomBytes } from "node:crypto";

import { Cron } from "croner";

export type ScheduleJob = {
  id: string;
  conversationId: string;
  /** What the agent should do when the job fires, in its own words. */
  text: string;
  createdAt: number;
  /** One-shot jobs fire once at this epoch millisecond. */
  at?: number;
  /** Recurring jobs: a five-field cron expression evaluated in timezone. */
  cron?: string;
  timezone?: string;
  lastRunAt?: number;
};

export type ScheduleSpec = {
  at?: string;
  inMinutes?: number;
  cron?: string;
  timezone?: string;
};

export const MAX_JOB_TEXT = 2_000;
export const MAX_MINUTES = 366 * 24 * 60;

export function createJobId(): string {
  return `sch_${randomBytes(4).toString("hex")}`;
}

/** Validate a tool request and turn it into a job. Exactly one of at, inMinutes, or cron is required. */
export function createJob(
  conversationId: string,
  text: string,
  spec: ScheduleSpec,
  now: number,
  defaultTimezone: string,
  id = createJobId(),
): ScheduleJob {
  const body = text.trim();
  if (!body) {
    throw new Error("text is required");
  }
  if (body.length > MAX_JOB_TEXT) {
    throw new Error(`text must be at most ${MAX_JOB_TEXT} characters`);
  }
  const given = [spec.at !== undefined, spec.inMinutes !== undefined, spec.cron !== undefined].filter(Boolean).length;
  if (given !== 1) {
    throw new Error("Give exactly one of at, in_minutes, or cron");
  }
  const base = { id, conversationId, text: body, createdAt: now };

  if (spec.cron !== undefined) {
    const cron = spec.cron.trim().replace(/\s+/g, " ");
    if (cron.split(" ").length !== 5) {
      throw new Error("cron must have five fields: minute hour day-of-month month day-of-week");
    }
    const timezone = validateTimezone(spec.timezone?.trim() || defaultTimezone);
    const job: ScheduleJob = { ...base, cron, timezone };
    if (nextRunAt(job, now) === undefined) {
      throw new Error(`cron never fires: ${cron}`);
    }
    return job;
  }

  if (spec.inMinutes !== undefined) {
    if (!Number.isInteger(spec.inMinutes) || spec.inMinutes < 1 || spec.inMinutes > MAX_MINUTES) {
      throw new Error(`in_minutes must be an integer from 1 to ${MAX_MINUTES}`);
    }
    return { ...base, at: now + spec.inMinutes * 60_000 };
  }

  const raw = spec.at?.trim() ?? "";
  const at = parseOffsetDateTime(raw);
  if (at <= now) {
    throw new Error("at must be in the future");
  }
  if (at - now > MAX_MINUTES * 60_000) {
    throw new Error("at must be within a year");
  }
  return { ...base, at };
}

/**
 * When the job should fire next, given that nothing before `after` is owed. One-shot jobs are owed until
 * they run, so a reminder missed while the station was down fires late rather than never. Recurring jobs
 * skip occurrences missed while down instead of replaying them.
 */
export function nextRunAt(job: ScheduleJob, after: number): number | undefined {
  if (job.cron === undefined) {
    return job.lastRunAt === undefined ? job.at : undefined;
  }
  const from = Math.max(after, job.lastRunAt ?? job.createdAt);
  const next = new Cron(job.cron, { timezone: job.timezone, paused: true }).nextRun(new Date(from));
  return next ? next.getTime() : undefined;
}

export function describeJob(job: ScheduleJob, after: number): Record<string, string | undefined> {
  const next = nextRunAt(job, after);
  return {
    id: job.id,
    text: job.text,
    schedule: job.cron === undefined ? "once" : `cron "${job.cron}" (${job.timezone})`,
    next: next === undefined ? undefined : new Date(next).toISOString(),
  };
}

export function parseJobs(text: string | undefined): ScheduleJob[] {
  if (!text?.trim()) {
    return [];
  }
  const raw = JSON.parse(text) as { jobs?: unknown };
  if (!Array.isArray(raw.jobs)) {
    throw new Error("schedule jobs must be a list");
  }
  return raw.jobs.filter(isJob);
}

export function formatJobs(jobs: readonly ScheduleJob[]): string {
  return `${JSON.stringify({ jobs }, null, 2)}\n`;
}

const OFFSET_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Parse an ISO 8601 date-time with an explicit offset, so "09:00" never silently means the station's local time.
 * Date.parse rolls impossible dates over (2026-02-30 becomes March 2), so every field is range-checked first.
 */
export function parseOffsetDateTime(raw: string): number {
  const match = OFFSET_DATE_TIME.exec(raw);
  if (!match) {
    throw new Error("at must be an ISO 8601 date-time with an offset, for example 2026-10-14T09:00:00+08:00");
  }
  const [year, month, day, hour, minute, second = 0, offsetHours = 0, offsetMinutes = 0] = [
    match[1], match[2], match[3], match[4], match[5], match[6], match[10], match[11],
  ].map((part) => (part === undefined ? undefined : Number(part))) as number[];
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  if (
    month! < 1 || month! > 12 || day! < 1 || day! > daysInMonth ||
    hour! > 23 || minute! > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59
  ) {
    throw new Error(`at is not a valid date-time: ${raw}`);
  }
  return Date.parse(raw);
}

export function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Unknown timezone: ${timezone}. Use an IANA name such as Asia/Shanghai.`);
  }
  return timezone;
}

function isJob(value: unknown): value is ScheduleJob {
  if (!value || typeof value !== "object") {
    return false;
  }
  const job = value as Partial<ScheduleJob>;
  return (
    typeof job.id === "string" &&
    typeof job.conversationId === "string" &&
    typeof job.text === "string" &&
    typeof job.createdAt === "number" &&
    (typeof job.at === "number" || typeof job.cron === "string")
  );
}
