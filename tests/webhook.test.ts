import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { MAX_BODY_BYTES, runWebhookServer, triggerText } from "../plugins/triggers/webhook/index";
import type { Trigger } from "../src/plugin/index";

test("webhook authenticates, fires a webhook trigger, and drains in-flight turns on stop", async () => {
  const fired: Trigger[] = [];
  let finishTurn!: () => void;
  const turnGate = new Promise<void>((resolve) => { finishTurn = resolve; });
  let listening!: (address: AddressInfo) => void;
  const address = new Promise<AddressInfo>((resolve) => { listening = resolve; });
  const controller = new AbortController();
  const running = runWebhookServer({
    token: "s3cret",
    port: 0,
    defaultConversation: "telegram:42",
    dispatch: async (trigger) => { fired.push(trigger); await turnGate; },
    onListening: listening,
  }, controller.signal);
  const { port } = await address;
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;
  const post = (path: string, body: string, headers: Record<string, string> = {}) =>
    fetch(url(path), { method: "POST", body, headers: { authorization: "Bearer s3cret", ...headers } });

  assert.equal((await fetch(url("/hooks/ci"), { method: "POST", body: "x" })).status, 401);
  assert.equal((await post("/hooks/ci", "x", { authorization: "Bearer s3cres" })).status, 401);
  assert.equal((await fetch(url("/hooks/ci?token=s3cret"), { method: "GET" })).status, 405);
  assert.equal((await post("/elsewhere", "x")).status, 404);
  assert.equal((await post("/hooks/ci", "x".repeat(MAX_BODY_BYTES + 1))).status, 413);
  assert.equal((await post("/hooks/ci", "   ")).status, 400);
  assert.equal(fired.length, 0);

  const accepted = await post("/hooks/ci", JSON.stringify({ text: "Build #7 failed on main" }), { "content-type": "application/json" });
  assert.equal(accepted.status, 202);
  assert.equal((await fetch(url("/hooks/deploy?token=s3cret&conversation=web:ops"), { method: "POST", body: "deployed v2" })).status, 202);
  assert.deepEqual(fired, [
    { kind: "webhook", source: "webhook:ci", conversationId: "telegram:42", text: "Build #7 failed on main", deliver: "conversation" },
    { kind: "webhook", source: "webhook:deploy", conversationId: "web:ops", text: "deployed v2", deliver: "conversation" },
  ]);

  controller.abort();
  let settled = false;
  void running.then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, "stop waits for accepted turns");
  finishTurn();
  await running;
});

test("webhook text uses a JSON text field and otherwise passes the body through", () => {
  assert.equal(triggerText('{"text":" hi "}', "application/json"), "hi");
  assert.equal(triggerText('{"action":"opened"}', "application/json"), '{"action":"opened"}');
  assert.equal(triggerText('{"text":"not parsed"}', "text/plain"), '{"text":"not parsed"}');
});
