import assert from "node:assert/strict";
import test from "node:test";

import { createStation, spokenTexts, streamedText } from "./harness";

test("a turn streams, runs a real plugin tool, and its history and memory survive a restart", async (t) => {
  const station = await createStation(t, {
    plugins: ["plugins/tools/notes"],
    tools: ["memory_save", "memory_search"],
    script: {
      "remember that I like green tea": [
        { toolCalls: [{ name: "memory_save", arguments: { text: "The user likes green tea." } }] },
        { text: "Saved: you like green tea, and I will keep that in mind for next time." },
      ],
      "what do I like to drink?": [
        { toolCalls: [{ name: "memory_search", arguments: { query: "green tea" } }] },
        { text: "You like green tea." },
      ],
    },
  });

  const first = await station.start();
  await first.request("thread/open", { threadId: "chat:1" });
  const turn = await first.runTurn("chat:1", "remember that I like green tea");

  assert.equal(turn.status, "completed", turn.error?.message);
  assert.equal(turn.result?.text, "Saved: you like green tea, and I will keep that in mind for next time.");
  const methods = turn.events.map((event) => event.method);
  assert.equal(methods[0], "turn/started");
  assert.equal(methods.at(-1), "turn/completed");
  assert.equal(methods.filter((method) => method === "turn/completed").length, 1);
  const started = turn.events.find((event) => event.method === "tool/started");
  const finished = turn.events.find((event) => event.method === "tool/completed");
  assert.equal(started?.params.name, "memory_save");
  assert.equal(finished?.params.callId, started?.params.callId);
  assert.equal(finished?.params.isError, false);
  assert.ok(methods.indexOf("tool/completed") < methods.indexOf("message/delta"));
  // The reply arrives in several deltas that add up to the authoritative completed text.
  const completed = turn.events.filter((event) => event.method === "message/completed");
  assert.equal(completed.length, 1);
  const deltas = turn.events.filter((event) => event.method === "message/delta");
  assert.ok(deltas.length > 1, `expected the reply in several deltas, got ${deltas.length}`);
  assert.equal(streamedText(turn.events).get(String(completed[0]?.params.messageId)), completed[0]?.params.text);
  assert.deepEqual(await first.close(), { code: 0, signal: null });

  const second = await station.start();
  assert.equal(second.agent.agentId, first.agent.agentId);
  const recall = await second.runTurn("chat:1", "what do I like to drink?");
  assert.equal(recall.status, "completed", recall.error?.message);
  assert.equal(recall.result?.text, "You like green tea.");

  // The restarted model saw the earlier turn, and the memory saved by the first process.
  const [, answer] = await station.modelRequests("what do I like to drink?");
  assert.equal(answer?.messages[0]?.role, "user");
  assert.equal(answer?.messages[0]?.role === "user" && answer.messages[0].text, "remember that I like green tea");
  const search = answer?.messages.at(-1);
  assert.equal(search?.role, "toolResult");
  assert.ok(search?.role === "toolResult" && !search.isError && /green tea/.test(search.text), JSON.stringify(search));

  const thread = await second.readThread("chat:1");
  assert.equal(thread.status, "idle");
  assert.deepEqual(
    thread.entries.map((entry) => entry.type),
    ["user", "assistant", "toolResult", "assistant", "user", "assistant", "toolResult", "assistant"],
  );
  assert.deepEqual(await second.close(), { code: 0, signal: null });
});

test("the model sees only allowlisted tools, and a call to an enabled but unlisted tool never runs", async (t) => {
  const station = await createStation(t, {
    tools: ["e2e__echo"],
    script: {
      "run the blocking tool": [
        { toolCalls: [{ name: "e2e__block", arguments: {} }] },
        { text: "I could not run it." },
      ],
    },
  });

  const server = await station.start();
  const turn = await server.runTurn("chat:1", "run the blocking tool");

  assert.equal(turn.status, "completed", turn.error?.message);
  const [request] = await station.modelRequests("run the blocking tool");
  assert.deepEqual(request?.tools, ["e2e__echo"]);
  const result = turn.events.find((event) => event.method === "tool/completed");
  assert.equal(result?.params.name, "e2e__block");
  assert.equal(result?.params.isError, true);
  assert.deepEqual(await station.toolLog(), []);
  await server.close();
});

test("turns queue per thread and run in parallel across threads; cancel ends only the active one", async (t) => {
  const station = await createStation(t, {
    tools: ["e2e__block"],
    script: {
      "wait for cancel": [{ toolCalls: [{ name: "e2e__block", arguments: {} }] }],
      "queued behind": [{ text: "ran after the canceled turn" }],
      "on another thread": [{ text: "not blocked" }],
    },
  });

  const server = await station.start();
  const blocked = await server.startTurn("chat:a", "wait for cancel");
  await server.waitFor(
    (event) => event.method === "tool/started" && event.params.turnId === blocked.turnId,
    "the blocking tool to start",
  );
  const queued = await server.startTurn("chat:a", "queued behind");
  assert.equal(queued.status, "queued");

  // Another thread is not held up by chat:a's active turn.
  const other = await server.runTurn("chat:b", "on another thread");
  assert.equal(other.result?.text, "not blocked");
  assert.deepEqual(server.events(queued.turnId), [], "the queued turn must not start while chat:a is busy");
  await assert.rejects(server.request("turn/cancel", { threadId: "chat:a", turnId: queued.turnId }));

  await server.request("turn/cancel", { threadId: "chat:a", turnId: blocked.turnId });
  const canceled = await server.completion(blocked.turnId);
  assert.equal(canceled.status, "canceled");
  const next = await server.completion(queued.turnId);
  assert.equal(next.status, "completed", next.error?.message);
  assert.equal(next.result?.text, "ran after the canceled turn");

  const order = server.notifications.map((event) => `${event.method} ${event.params.turnId}`);
  assert.ok(order.indexOf(`turn/completed ${blocked.turnId}`) < order.indexOf(`turn/started ${queued.turnId}`));
  assert.equal(server.events(blocked.turnId).filter((event) => event.method === "turn/completed").length, 1);
  assert.deepEqual(
    (await station.toolLog()).map((entry) => entry.event),
    ["started", "aborted"],
    "the tool observes the cancellation through its AbortSignal",
  );
  assert.deepEqual(spokenTexts(await server.readThread("chat:a")), [
    "wait for cancel",
    "queued behind",
    "ran after the canceled turn",
  ]);
  await server.close();
});

test("reset hides earlier history from the model and thread/read, also after a restart, but storage keeps it", async (t) => {
  const station = await createStation(t, {
    tools: [],
    script: {
      "before the reset": [{ text: "first answer" }],
      "after the reset": [{ text: "second answer" }],
    },
  });

  const first = await station.start();
  assert.equal((await first.runTurn("chat:1", "before the reset")).status, "completed");
  await first.request("thread/reset", { threadId: "chat:1" });
  assert.equal((await first.runTurn("chat:1", "after the reset")).status, "completed");

  const [request] = await station.modelRequests("after the reset");
  assert.deepEqual(request?.messages, [{ role: "user", text: "after the reset" }]);
  assert.deepEqual(spokenTexts(await first.readThread("chat:1")), ["after the reset", "second answer"]);
  await first.close();

  const second = await station.start();
  assert.deepEqual(spokenTexts(await second.readThread("chat:1")), ["after the reset", "second answer"]);
  await second.close();
  assert.match(await station.capsuleContents(), /before the reset/);
});

test("a turn that exceeds its budget or gets a model error fails without blocking the thread", async (t) => {
  const echo = (text: string) => ({ toolCalls: [{ name: "e2e__echo", arguments: { text } }] });
  const station = await createStation(t, {
    tools: ["e2e__echo"],
    limits: { maxModelTurns: 2 },
    script: {
      "loop forever": [echo("one"), echo("two"), echo("three")],
      "fail upstream": [{ error: "upstream exploded" }],
      "still there?": [{ text: "yes" }],
    },
  });

  const server = await station.start();
  const looping = await server.runTurn("chat:1", "loop forever");
  assert.equal(looping.status, "failed");
  assert.match(looping.error?.message ?? "", /2 model-turn limit/);
  assert.equal((await station.modelRequests("loop forever")).length, 2);

  const upstream = await server.runTurn("chat:1", "fail upstream");
  assert.equal(upstream.status, "failed");
  assert.match(upstream.error?.message ?? "", /upstream exploded/);

  const after = await server.runTurn("chat:1", "still there?");
  assert.equal(after.status, "completed", after.error?.message);
  assert.equal(after.result?.text, "yes");

  // The failed turn's completed work stays in the thread.
  const entries = (await server.readThread("chat:1")).entries;
  const echoed = entries.flatMap((entry) => (entry.type === "toolResult" ? [entry.content] : []));
  assert.deepEqual(echoed[0], [{ type: "text", text: "one" }]);
  await server.close();
});

test("a listed skill is advertised to the model and loaded through the skill tool", async (t) => {
  const station = await createStation(t, {
    tools: [],
    skills: {
      "tea-ceremony": [
        "---",
        "name: tea-ceremony",
        "description: Explain how to brew tea. Use when asked how to make tea.",
        "---",
        "",
        "Steep green tea at 80C for two minutes.",
      ].join("\n"),
    },
    script: {
      "how do I make tea?": [
        { toolCalls: [{ name: "skill", arguments: { name: "tea-ceremony" } }] },
        { text: "80C, two minutes." },
      ],
    },
  });

  const server = await station.start();
  const turn = await server.runTurn("chat:1", "how do I make tea?");
  assert.equal(turn.status, "completed", turn.error?.message);

  const [first, second] = await station.modelRequests("how do I make tea?");
  assert.deepEqual(first?.tools, ["skill"]);
  assert.match(first?.system ?? "", /tea-ceremony/);
  assert.match(first?.system ?? "", /Use when asked how to make tea/);
  assert.doesNotMatch(first?.system ?? "", /Steep green tea/, "instructions load on demand, not up front");
  const loaded = second?.messages.at(-1);
  assert.ok(loaded?.role === "toolResult" && !loaded.isError && /Steep green tea at 80C/.test(loaded.text));
  await server.close();
});

test("closing stdin cancels the active turn, persists it, and exits cleanly", async (t) => {
  const station = await createStation(t, {
    tools: ["e2e__block"],
    script: { "wait for cancel": [{ toolCalls: [{ name: "e2e__block", arguments: {} }] }] },
  });

  const first = await station.start();
  const turn = await first.startTurn("chat:1", "wait for cancel");
  await first.waitFor((event) => event.method === "tool/started" && event.params.turnId === turn.turnId, "tool start");
  assert.deepEqual(await first.close(), { code: 0, signal: null });
  assert.deepEqual((await station.toolLog()).map((entry) => entry.event), ["started", "aborted"]);

  const second = await station.start();
  const thread = await second.readThread("chat:1");
  assert.equal(thread.status, "idle");
  assert.deepEqual(spokenTexts(thread), ["wait for cancel"]);
  await second.close();
});
