import assert from "node:assert/strict";
import test from "node:test";

import { createStation } from "./harness";

test("--once prints the reply and the next run continues the same conversation", async (t) => {
  const station = await createStation(t, {
    tools: [],
    script: {
      hello: [{ text: "hi from the scripted model" }],
      "hello again": [{ text: "hi again" }],
    },
  });

  const first = await station.once("hello");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.stdout.trim().split("\n").at(-1), "hi from the scripted model");

  const second = await station.once("hello again");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout.trim().split("\n").at(-1), "hi again");
  const [request] = await station.modelRequests("hello again");
  assert.deepEqual(
    request?.messages.map((message) => message.text),
    ["hello", "hi from the scripted model", "hello again"],
  );
});
