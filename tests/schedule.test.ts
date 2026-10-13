import assert from "node:assert/strict";
import test from "node:test";

import schedulePlugin, { createScheduler, JOBS_KEY } from "../plugins/triggers/schedule/index";
import { createJob, nextRunAt, parseJobs } from "../plugins/triggers/schedule/schedule";
import { createMemoryCapsule } from "../src/capsule";
import { createPluginRegistry, type Trigger } from "../src/plugin/index";

const T0 = Date.parse("2026-10-13T00:30:00Z");

test("createJob accepts exactly one well-formed schedule", () => {
  assert.equal(createJob("c", "ping", { inMinutes: 5 }, T0, "UTC").at, T0 + 5 * 60_000);
  assert.equal(createJob("c", "ping", { at: "2026-10-13T09:00:00+08:00" }, T0, "UTC").at, Date.parse("2026-10-13T01:00:00Z"));
  assert.throws(() => createJob("c", "ping", { at: "2026-10-13T09:00:00" }, T0, "UTC"), /offset/);
  assert.throws(() => createJob("c", "ping", { at: "2026-10-12T09:00:00Z" }, T0, "UTC"), /future/);
  // Date.parse would roll these over to another day instead of rejecting them.
  assert.throws(() => createJob("c", "ping", { at: "2027-02-30T09:00:00Z" }, T0, "UTC"), /not a valid date-time/);
  assert.throws(() => createJob("c", "ping", { at: "2026-11-31T09:00:00+08:00" }, T0, "UTC"), /not a valid date-time/);
  assert.throws(() => createJob("c", "ping", { at: "2026-12-01T24:00:00Z" }, T0, "UTC"), /not a valid date-time/);
  assert.throws(() => createJob("c", "ping", { at: "2027-02-29T09:00:00Z" }, T0, "UTC"), /not a valid date-time/);
  assert.equal(createJob("c", "ping", { at: "2027-02-28T23:59:59-01:00" }, T0, "UTC").at, Date.parse("2027-03-01T00:59:59Z"));
  assert.throws(() => createJob("c", "ping", { inMinutes: 5, cron: "* * * * *" }, T0, "UTC"), /exactly one/);
  assert.throws(() => createJob("c", "ping", { cron: "*/5 * * * * *" }, T0, "UTC"), /five fields/);
  assert.throws(() => createJob("c", "ping", { cron: "0 9 * * *", timezone: "Mars/Base" }, T0, "UTC"), /Unknown timezone/);
  assert.throws(() => createJob("c", "  ", { inMinutes: 5 }, T0, "UTC"), /text is required/);
});

test("cron runs in the job's timezone and skips occurrences missed while the station was down", () => {
  const job = createJob("c", "brief", { cron: "0 9 * * *", timezone: "Asia/Shanghai" }, T0, "UTC");
  // 09:00 in Shanghai is 01:00 UTC.
  assert.equal(nextRunAt(job, T0), Date.parse("2026-10-13T01:00:00Z"));
  const ran = { ...job, lastRunAt: Date.parse("2026-10-13T01:00:00Z") };
  assert.equal(nextRunAt(ran, T0), Date.parse("2026-10-14T01:00:00Z"));
  // Restarting three days later schedules the next future occurrence, not the missed ones.
  assert.equal(nextRunAt(ran, Date.parse("2026-10-16T12:00:00Z")), Date.parse("2026-10-17T01:00:00Z"));
  // A one-shot reminder stays owed until it runs.
  const once = createJob("c", "call", { inMinutes: 1 }, T0, "UTC");
  assert.equal(nextRunAt(once, T0 + 10 * 86_400_000), T0 + 60_000);
});

test("the scheduler fires due jobs as schedule triggers, records them first, and wakes on new jobs", async () => {
  const capsule = createMemoryCapsule({ blueprintName: "schedule" });
  let clock = T0;
  const fired: Trigger[] = [];
  const statesAtFire: string[] = [];
  const scheduler = createScheduler({
    state: () => capsule.state,
    timezone: "UTC",
    now: () => clock,
    dispatch: async (trigger) => {
      fired.push(trigger);
      statesAtFire.push((await capsule.state.read(JOBS_KEY)) ?? "");
      return { text: "" };
    },
  });
  const once = await scheduler.create("telegram:1", "Remind the user to stretch.", { inMinutes: 1 });
  const daily = await scheduler.create("telegram:1", "Morning brief.", { cron: "0 1 * * *" });

  const controller = new AbortController();
  const running = scheduler.run(controller.signal);
  try {
    // Any job change wakes the sleeping loop, which then re-reads the clock.
    clock = Date.parse("2026-10-13T01:00:30Z");
    await scheduler.cancel("telegram:1", "sch_missing");
    await waitFor(() => fired.length === 2);

    assert.deepEqual(fired.map((trigger) => [trigger.kind, trigger.source, trigger.conversationId, trigger.deliver, trigger.text]).sort(), [
      ["schedule", `schedule:${daily.id}`, "telegram:1", "conversation", "Morning brief."],
      ["schedule", `schedule:${once.id}`, "telegram:1", "conversation", "Remind the user to stretch."],
    ].sort());
    // At-most-once: by the time a job's turn starts, the one-shot is gone and the cron run is recorded.
    const persisted = parseJobs(statesAtFire[0]);
    assert.deepEqual(persisted.map((job) => [job.id, job.lastRunAt]), [[daily.id, clock]]);

    const later = await scheduler.create("telegram:2", "Check the oven.", { inMinutes: 1 });
    clock += 61_000;
    await scheduler.cancel("telegram:2", "sch_missing");
    await waitFor(() => fired.length === 3);
    assert.equal(fired[2]?.source, `schedule:${later.id}`);
  } finally {
    controller.abort();
    await running;
  }
  assert.equal(fired.length, 3);
});

test("a recurring occurrence that passed before the station started is skipped", async () => {
  const capsule = createMemoryCapsule({ blueprintName: "schedule-missed" });
  let clock = T0;
  const fired: Trigger[] = [];
  const scheduler = createScheduler({
    state: () => capsule.state,
    timezone: "UTC",
    now: () => clock,
    dispatch: async (trigger) => { fired.push(trigger); return { text: "" }; },
  });
  await scheduler.create("telegram:1", "Morning brief.", { cron: "0 1 * * *" });
  clock = Date.parse("2026-10-13T01:00:30Z");
  const controller = new AbortController();
  const running = scheduler.run(controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 50));
  controller.abort();
  await running;
  assert.deepEqual(fired, []);
});

test("schedule tools are scoped to the calling conversation", async () => {
  const capsule = createMemoryCapsule({ blueprintName: "schedule-tools" });
  const capsuleRef = { agentId: capsule.identity.agentId, state: capsule.state };
  const registry = createPluginRegistry({ env: { ZING_TIMEZONE: "Asia/Shanghai" }, capsule: capsuleRef });
  schedulePlugin(registry.api);
  assert.deepEqual(registry.listTriggerSources().map((source) => source.id), ["schedule"]);
  const context = (conversationId: string) => ({
    signal: new AbortController().signal,
    conversationId,
    trigger: { kind: "message" },
    capsule: capsuleRef,
  });
  const create = registry.getTool("schedule_create");
  const list = registry.getTool("schedule_list");
  const cancel = registry.getTool("schedule_cancel");
  assert.ok(create && list && cancel);

  const created = await create.execute({ text: "Water the plants.", cron: "0 8 * * *" }, context("telegram:1"));
  const { scheduled, timezone } = created.details as { scheduled: { id: string; schedule: string }; timezone: string };
  assert.equal(timezone, "Asia/Shanghai");
  assert.equal(scheduled.schedule, 'cron "0 8 * * *" (Asia/Shanghai)');
  await assert.rejects(create.execute({ text: "x", cron: "0 8 * * *", in_minutes: 3 }, context("telegram:1")), /exactly one/);

  assert.deepEqual((await list.execute({}, context("telegram:2")).then((result) => result.details) as { jobs: unknown[] }).jobs, []);
  assert.deepEqual((await cancel.execute({ id: scheduled.id }, context("telegram:2"))).details, { canceled: false, id: scheduled.id });
  assert.equal(parseJobs(await capsule.state.read(JOBS_KEY)).length, 1);
  assert.deepEqual((await cancel.execute({ id: scheduled.id }, context("telegram:1"))).details, { canceled: true, id: scheduled.id });
  assert.equal(parseJobs(await capsule.state.read(JOBS_KEY)).length, 0);
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}
