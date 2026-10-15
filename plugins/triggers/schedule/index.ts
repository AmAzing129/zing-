import { Type, type JsonValue } from "@earendil-works/pi-ai";
import type { CapsuleState, Trigger, ZingPluginAPI } from "zing";

import {
  MAX_JOB_TEXT,
  MAX_MINUTES,
  createJob,
  describeJob,
  formatJobs,
  nextRunAt,
  parseJobs,
  validateTimezone,
  type ScheduleJob,
  type ScheduleSpec,
} from "./schedule";

export const SCHEDULE_SOURCE_ID = "schedule";
export const JOBS_KEY = "schedule/jobs.json";
export const MAX_JOBS_PER_CONVERSATION = 20;
const MAX_SLEEP_MS = 60 * 60_000;

export const scheduleCreateParameters = Type.Object({
  text: Type.String({
    minLength: 1,
    maxLength: MAX_JOB_TEXT,
    description: "What you should do when the job fires, written as an instruction to yourself, e.g. \"Remind the user to call Mom.\"",
  }),
  at: Type.Optional(Type.String({ description: "One-shot time: ISO 8601 date-time with an offset, e.g. 2026-10-14T09:00:00+08:00." })),
  in_minutes: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MINUTES, description: "One-shot delay in minutes from now." })),
  cron: Type.Optional(Type.String({ description: "Recurring: five-field cron, e.g. \"0 9 * * 1-5\" for 09:00 on weekdays." })),
  timezone: Type.Optional(Type.String({ description: "IANA timezone for cron, e.g. Asia/Shanghai. Defaults to the station timezone." })),
});
export const scheduleCancelParameters = Type.Object({
  id: Type.String({ minLength: 1, description: "Job id from schedule_create or schedule_list." }),
});

export type Scheduler = {
  create: (conversationId: string, text: string, spec: ScheduleSpec) => Promise<ScheduleJob>;
  list: (conversationId: string) => Promise<ScheduleJob[]>;
  cancel: (conversationId: string, id: string) => Promise<boolean>;
  /** The trigger source loop: fire due jobs until the signal aborts. */
  run: (signal: AbortSignal) => Promise<void>;
};

export type SchedulerOptions = {
  state: () => CapsuleState;
  dispatch: (trigger: Trigger) => Promise<unknown>;
  timezone: string;
  now?: () => number;
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  const now = options.now ?? Date.now;
  let tail: Promise<unknown> = Promise.resolve();
  let wake: (() => void) | undefined;
  // Set when jobs change after the loop last read them, so a change made just before sleeping is not missed.
  let dirty = false;

  // Every read-modify-write of the job list goes through one queue.
  const mutate = <T>(change: (jobs: ScheduleJob[]) => { jobs?: ScheduleJob[]; result: T }): Promise<T> => {
    const work = tail.then(async () => {
      const state = options.state();
      const jobs = parseJobs(await state.read(JOBS_KEY));
      const { jobs: next, result } = change(jobs);
      if (next) {
        await state.write(JOBS_KEY, formatJobs(next));
      }
      return result;
    });
    tail = work.catch(() => undefined);
    return work;
  };

  const changed = <T>(value: T): T => {
    dirty = true;
    wake?.();
    return value;
  };

  return {
    async create(conversationId, text, spec) {
      const job = await mutate((jobs) => {
        if (jobs.filter((entry) => entry.conversationId === conversationId).length >= MAX_JOBS_PER_CONVERSATION) {
          throw new Error(`This conversation already has ${MAX_JOBS_PER_CONVERSATION} scheduled jobs; cancel one first.`);
        }
        const created = createJob(conversationId, text, spec, now(), options.timezone);
        return { jobs: [...jobs, created], result: created };
      });
      return changed(job);
    },
    list: (conversationId) =>
      mutate((jobs) => ({ result: jobs.filter((job) => job.conversationId === conversationId) })),
    async cancel(conversationId, id) {
      const removed = await mutate((jobs) => {
        const kept = jobs.filter((job) => !(job.id === id && job.conversationId === conversationId));
        return kept.length === jobs.length ? { result: false } : { jobs: kept, result: true };
      });
      return changed(removed);
    },
    async run(signal) {
      const startedAt = now();
      const inFlight = new Set<Promise<void>>();
      try {
        while (!signal.aborted) {
          dirty = false;
          const due = await mutate((jobs) => {
            const at = now();
            const fired: ScheduleJob[] = [];
            const kept: ScheduleJob[] = [];
            for (const job of jobs) {
              const next = nextRunAt(job, startedAt);
              if (next !== undefined && next <= at) {
                fired.push(job);
                // Record the run before dispatching: a crash mid-turn must not replay the job.
                if (job.cron !== undefined) kept.push({ ...job, lastRunAt: at });
              } else if (next !== undefined) {
                kept.push(job);
              }
            }
            return { jobs: kept.length === jobs.length && fired.length === 0 ? undefined : kept, result: { fired, kept } };
          });
          for (const job of due.fired) {
            const work = options
              .dispatch({
                kind: "schedule",
                source: `schedule:${job.id}`,
                conversationId: job.conversationId,
                text: job.text,
                deliver: "conversation",
              })
              .then(
                () => undefined,
                (error: unknown) => console.error(`Scheduled job ${job.id} failed`, error),
              );
            inFlight.add(work);
            void work.finally(() => inFlight.delete(work));
          }
          const upcoming = due.kept
            .map((job) => nextRunAt(job, startedAt))
            .filter((next): next is number => next !== undefined);
          const delay = upcoming.length > 0 ? Math.min(...upcoming) - now() : MAX_SLEEP_MS;
          if (!dirty) {
            await sleep(Math.max(0, Math.min(delay, MAX_SLEEP_MS)), signal, (resume) => { wake = resume; });
          }
          wake = undefined;
        }
      } finally {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}

export default function schedulePlugin(zing: ZingPluginAPI) {
  const timezone = validateTimezone(
    zing.env.ZING_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const scheduler = createScheduler({
    state: () => zing.capsule.state,
    dispatch: (trigger) => zing.host.dispatch(trigger),
    timezone,
  });

  zing.registerTriggerSource({ id: SCHEDULE_SOURCE_ID, start: (signal) => scheduler.run(signal) });

  zing.registerTool({
    name: "schedule_create",
    description:
      "Schedule yourself to act later in this conversation: a one-shot reminder (at or in_minutes) or a recurring job (cron). " +
      "When it fires you receive the text as a schedule trigger here, and your reply is sent to the user. " +
      "Use in_minutes for relative times. The result includes the current time.",
    parameters: scheduleCreateParameters,
    async execute(input, context) {
      context.signal.throwIfAborted();
      const job = await scheduler.create(context.conversationId, String(input.text ?? ""), {
        at: optionalString(input.at),
        inMinutes: typeof input.in_minutes === "number" ? input.in_minutes : undefined,
        cron: optionalString(input.cron),
        timezone: optionalString(input.timezone),
      });
      return result({ scheduled: describeJob(job, Date.now()), now: new Date().toISOString(), timezone });
    },
  });

  zing.registerTool({
    name: "schedule_list",
    description: "List the jobs scheduled in this conversation, with their next run time and the current time.",
    parameters: Type.Object({}),
    async execute(_input, context) {
      context.signal.throwIfAborted();
      const jobs = await scheduler.list(context.conversationId);
      return result({ jobs: jobs.map((job) => describeJob(job, Date.now())), now: new Date().toISOString(), timezone });
    },
  });

  zing.registerTool({
    name: "schedule_cancel",
    description: "Cancel a job scheduled in this conversation.",
    parameters: scheduleCancelParameters,
    async execute(input, context) {
      context.signal.throwIfAborted();
      const id = String(input.id ?? "").trim();
      const canceled = await scheduler.cancel(context.conversationId, id);
      return result({ canceled, id });
    },
  });
}

function result(details: Record<string, unknown>): { text: string; details: JsonValue } {
  const text = JSON.stringify(details);
  return { text, details: JSON.parse(text) as JsonValue };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sleep(ms: number, signal: AbortSignal, onWake: (resume: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    onWake(done);
    if (signal.aborted) done();
  });
}
