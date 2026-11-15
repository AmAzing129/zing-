import assert from "node:assert/strict";
import test from "node:test";

import { createStation, spokenTexts } from "./harness";

const blockThenAnswer = {
  tools: ["e2e__block"],
  runtime: "durable" as const,
  script: {
    "block until interrupted": [
      { toolCalls: [{ name: "e2e__block", arguments: {} }] },
      { text: "recovered after the interruption" },
    ],
    "anything else?": [{ text: "nothing else" }],
  },
};

test("a station killed mid-tool resumes the turn after restart without running the tool again", async (t) => {
  const station = await createStation(t, blockThenAnswer);

  const first = await station.start();
  const turn = await first.startTurn("chat:1", "block until interrupted");
  await first.waitFor((event) => event.method === "tool/started" && event.params.turnId === turn.turnId, "tool start");
  assert.deepEqual(await first.kill("SIGKILL"), { code: null, signal: "SIGKILL" });

  // Nobody observes the resumed turn over the new connection; thread/read is how a client reconciles.
  const second = await station.start();
  const deadline = Date.now() + 15_000;
  let texts = spokenTexts(await second.readThread("chat:1"));
  while (texts.at(-1) !== "recovered after the interruption" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    texts = spokenTexts(await second.readThread("chat:1"));
  }
  assert.deepEqual(texts, ["block until interrupted", "recovered after the interruption"]);

  assert.deepEqual(
    (await station.toolLog()).map((entry) => `${entry.tool} ${entry.event}`),
    ["e2e__block started"],
    "the interrupted call is not replayed",
  );
  const resumed = (await station.modelRequests("block until interrupted"))[1];
  const interrupted = resumed?.messages.at(-1);
  assert.ok(interrupted?.role === "toolResult" && interrupted.toolName === "e2e__block" && interrupted.isError);
  assert.match(interrupted.text, /was interrupted/);
  assert.equal((await second.readThread("chat:1")).status, "idle");
  await second.close();
});

test("SIGTERM cancels the connection's turn, exits 143, and the turn does not resume after restart", async (t) => {
  const station = await createStation(t, blockThenAnswer);

  const first = await station.start();
  const turn = await first.startTurn("chat:1", "block until interrupted");
  await first.waitFor((event) => event.method === "tool/started" && event.params.turnId === turn.turnId, "tool start");
  assert.deepEqual(await first.kill("SIGTERM"), { code: 143, signal: null });
  assert.equal((await first.completion(turn.turnId)).status, "canceled");
  assert.deepEqual((await station.toolLog()).map((entry) => entry.event), ["started", "aborted"]);

  // Turns on one thread run in order, so had the canceled turn resumed, it would answer before this one.
  const second = await station.start();
  const next = await second.runTurn("chat:1", "anything else?");
  assert.equal(next.result?.text, "nothing else");
  assert.equal((await station.modelRequests("block until interrupted")).length, 1);
  assert.deepEqual(spokenTexts(await second.readThread("chat:1")), [
    "block until interrupted",
    "anything else?",
    "nothing else",
  ]);
  await second.close();
});
