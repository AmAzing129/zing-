import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import plugin, { createNotes, engineAllowsWrite } from "../plugins/tools/notes/index";
import { appendBullet, entryText, extractNote, rankNotes, tokenize } from "../plugins/tools/notes/notes";
import { defaultBlueprint } from "../src/blueprint";
import { createMemoryCapsule, openFileCapsule, type Capsule } from "../src/capsule";
import { createPluginRegistry, loadPlugin, type CapsuleRef } from "../src/plugin/index";

const reference = (capsule: Capsule, agentId = capsule.identity.agentId): CapsuleRef => ({
  agentId,
  state: capsule.state,
});
const ram = (agentId: string): CapsuleRef => reference(createMemoryCapsule({ blueprintName: "notes", agentId }));
const disk = async (path: string, agentId: string): Promise<CapsuleRef> =>
  reference(await openFileCapsule({ blueprint: defaultBlueprint(), path }), agentId);

test("storage queue identity follows the capsule state", () => {
  const capsule = createMemoryCapsule({ blueprintName: "notes" });
  assert.strictEqual(reference(capsule, "one").state, reference(capsule, "two").state);
  assert.notStrictEqual(ram("one").state, ram("two").state);
});

test("extractNote retains remember-intent, long declaratives, and URL/short rejection", () => {
  assert.match(extractNote("记住：我喜欢 TypeScript") ?? "", /TypeScript/);
  assert.match(extractNote("Remember that I only drink oat milk") ?? "", /oat milk/);
  assert.match(extractNote("I prefer TypeScript for all new services and will not accept Java in this repo.") ?? "", /TypeScript/);
  assert.equal(extractNote("what is the weather?"), undefined);
  assert.equal(extractNote("https://example.com"), undefined);
  assert.equal(extractNote("too short"), undefined);
});

test("appendBullet reuses the last heading and text blocks concatenate exactly", () => {
  const notes = appendBullet(appendBullet("", "2026-08-15", "one"), "2026-08-15", "two");
  assert.equal([...notes.matchAll(/^## /gm)].length, 1);
  assert.deepEqual(tokenize("Tea tea 咖啡"), ["tea", "咖啡"]);
  assert.equal(entryText({ type: "user", at: 1, content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] }), "onetwo");
});

test("rankNotes scores English and keeps file order for ties", () => {
  const markdown = "## 2026-01-01\n\n- [owner] c — TypeScript alpha\n- [owner] c — TypeScript beta\n";
  const hits = rankNotes(markdown, "TypeScript", 5);
  assert.match(hits[0]?.text ?? "", /alpha/);
  assert.equal(hits[0]?.origin, "owner");
  assert.ok((hits[0]?.score ?? 0) > 0);
});

test("rankNotes segments Chinese words", () => {
  const markdown = "## 2026-01-01\n\n- [owner] c — 我住在上海\n- [owner] c — 我喜欢喝咖啡\n";
  assert.match(rankNotes(markdown, "住在哪", 5)[0]?.text ?? "", /上海/);
  assert.match(rankNotes(markdown, "上海", 5)[0]?.text ?? "", /上海/);
  assert.equal(rankNotes(markdown, "北京", 5).length, 0);
});

test("owner classification defaults safely and supports configuration", () => {
  const configured = createNotes({ ZING_MEMORY_OWNER_IDS: " alice " });
  assert.equal(configured.classify("alice"), "owner");
  assert.equal(configured.classify("bob"), "untrusted");
  assert.equal(configured.classify(), "untrusted");
  const defaults = createNotes({});
  assert.equal(defaults.classify(), "owner");
  assert.equal(defaults.classify("alice"), "untrusted");
});

test("observer persists owner user notes, advances untrusted cursor, and ignores reset/abort", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-notes-"));
  const capsule = await disk(path, "disk");
  const notes = createNotes({});
  const signal = new AbortController().signal;
  await notes.observe({ type: "turn", conversationId: "c", capsule, status: "completed", entries: [
    { type: "user", at: 1, content: "Remember that I prefer TypeScript" },
    { type: "user", at: 2, content: "hi?" },
    { type: "assistant", at: 3, content: [{ type: "text", text: "ok" }] },
  ] }, signal);
  await notes.observe({ type: "turn", conversationId: "c", senderId: "mallory", capsule, status: "completed", entries: [
    { type: "user", at: 4, content: "Remember that I prefer Java" },
  ] }, signal);
  await notes.observe({ type: "reset", conversationId: "c", capsule }, signal);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(
    async () => notes.observe({ type: "turn", conversationId: "c", capsule, status: "completed", entries: [{ type: "user", at: 5, content: "Remember Go forever" }] }, aborted.signal),
    /aborted/i,
  );
  const markdown = await readFile(join(path, "memory", "notes.md"), "utf8");
  assert.match(markdown, /TypeScript/); assert.doesNotMatch(markdown, /Java|hi\?|Go/);
  assert.equal((await readFile(join(path, "memory", "ENGINE"), "utf8")).trim(), "notes");
  const cursor = JSON.parse(await readFile(join(path, "memory", "derived", "cursor.json"), "utf8"));
  assert.equal(cursor.c.at, 4);
  assert.match((await notes.search(capsule, "TypeScript"))[0]?.text ?? "", /TypeScript/);

  const emptyPath = await mkdtemp(join(tmpdir(), "zing-notes-aborted-observer-"));
  const emptyCapsule = await disk(emptyPath, "never");
  await assert.rejects(async () => notes.observe({ type: "turn", conversationId: "never", capsule: emptyCapsule, status: "completed", entries: [
    { type: "user", at: 6, content: "Remember this aborted observer must never write" },
  ] }, aborted.signal), /aborted/i);
  await assert.rejects(readFile(join(emptyPath, "memory", "ENGINE"), "utf8"), /ENOENT/);
});

test("save/search isolate RAM, deduplicate, compress and frame untrusted origin", async () => {
  const notes = createNotes({ ZING_MEMORY_OWNER_IDS: "alice" });
  const capsule = ram("one");
  assert.equal(await notes.save(capsule, "c", "  我住在   上海  ", "owner", 1), true);
  assert.equal(await notes.save(capsule, "c", "我住在 上海", "owner", 2), false);
  await notes.save(capsule, "c", `我住在北京 ${"x".repeat(400)}`, "untrusted", 3);
  const hits = await notes.search(capsule, "住在哪", 99);
  assert.match(hits.map((hit) => hit.text).join("\n"), /上海/);
  assert.match(hits.map((hit) => hit.text).join("\n"), /\[untrusted\].*北京/);
  assert.equal((await createNotes({}).search(ram("other"), "上海")).length, 0);
});

test("canceling a queued save after invocation rejects without claiming or writing storage", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-notes-canceled-save-"));
  const notes = createNotes({});
  const controller = new AbortController();
  const capsule = await disk(path, "canceled");
  const saving = notes.save(
    capsule,
    "c",
    "Remember canceled writes never persist",
    "owner",
    1,
    controller.signal,
  );
  controller.abort();

  await assert.rejects(saving, (error) => error instanceof DOMException && error.name === "AbortError");
  await assert.rejects(readFile(join(path, "memory", "ENGINE"), "utf8"), /ENOENT/);
  assert.deepEqual(await notes.search(capsule, "canceled"), []);
});

test("search waits for the mutation already queued at call time", async () => {
  const notes = createNotes({});
  const capsule = ram("read-after-write");
  const saving = notes.save(capsule, "c", "Remember queued writes are visible", "owner", 1);
  assert.match((await notes.search(capsule, "queued"))[0]?.text ?? "", /queued writes/);
  await saving;
});

test("a mutation waits for the search already queued at call time", async () => {
  const notes = createNotes({});
  const capsule = ram("write-after-read");
  await notes.save(capsule, "c", "Remember the original note", "owner", 1);
  const searching = notes.search(capsule, "note");
  const saving = notes.save(capsule, "c", "Remember the later note", "owner", 2);

  assert.doesNotMatch((await searching).map((hit) => hit.text).join("\n"), /later/);
  await saving;
  assert.match((await notes.search(capsule, "later"))[0]?.text ?? "", /later/);
});

test("untrusted text has exactly one trust frame while owner text is unchanged", async () => {
  const notes = createNotes({});
  const capsule = ram("trust-frame");
  await notes.save(capsule, "c", "[untrusted] Remember external preference", "untrusted", 1);
  await notes.save(capsule, "c", "[untrusted] Remember owner preference", "owner", 2);
  const external = (await notes.search(capsule, "external"))[0]?.text ?? "";
  const owner = (await notes.search(capsule, "owner"))[0]?.text ?? "";
  assert.equal((external.match(/\[untrusted\]/g) ?? []).length, 1);
  assert.equal((owner.match(/\[untrusted\]/g) ?? []).length, 1);
});

test("concurrent disk saves retain both notes and ENGINE mismatch rejects", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-notes-concurrent-"));
  const capsule = await disk(path, "concurrent");
  const notes = createNotes({});
  const saved = await Promise.all([
    notes.save(capsule, "c", "Remember alpha preference forever", "owner", 1),
    notes.save(capsule, "c", "Remember beta preference forever", "owner", 2),
  ]);
  assert.deepEqual(saved, [true, true]);
  const markdown = await readFile(join(path, "memory", "notes.md"), "utf8");
  assert.match(markdown, /alpha/); assert.match(markdown, /beta/);

  const blockedRoot = await mkdtemp(join(tmpdir(), "zing-notes-blocked-"));
  const blocked = await disk(blockedRoot, "blocked");
  await blocked.state.write("memory/ENGINE", "other\n");
  await assert.rejects(
    notes.save(blocked, "c", "Remember this must not save", "owner", 1),
    /managed by another engine/,
  );
  await notes.observe({
    type: "turn",
    conversationId: "c",
    capsule: blocked,
    status: "completed",
    entries: [{ type: "user", at: 2, content: "Remember observer remains harmless" }],
  }, new AbortController().signal);
  await blocked.state.write("memory/ENGINE", "notes\n");
  assert.equal(await notes.save(blocked, "c", "Remember recovery works", "owner", 3), true);
});

test("disk saves with different agent IDs share one mutation queue", async () => {
  const path = await mkdtemp(join(tmpdir(), "zing-notes-shared-disk-"));
  const notes = createNotes({});
  const capsule = await openFileCapsule({ blueprint: defaultBlueprint(), path });
  const saved = await Promise.all([
    notes.save(reference(capsule, "one"), "c", "Remember first shared note", "owner", 1),
    notes.save(reference(capsule, "two"), "c", "Remember second shared note", "owner", 2),
  ]);
  assert.deepEqual(saved, [true, true]);
  const markdown = await readFile(join(path, "memory", "notes.md"), "utf8");
  assert.match(markdown, /first shared/);
  assert.match(markdown, /second shared/);
});

test("the first ENGINE claim is exclusive and existing claims remain stable", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-notes-engine-"));
  const capsule = await disk(root, "engine");
  const [notesWon, otherWon] = await Promise.all([
    engineAllowsWrite(capsule.state, "notes"),
    engineAllowsWrite(capsule.state, "other"),
  ]);
  assert.equal(Number(notesWon) + Number(otherWon), 1);
  const winner = notesWon ? "notes" : "other";
  assert.equal((await readFile(join(root, "memory", "ENGINE"), "utf8")).trim(), winner);
  assert.equal(await engineAllowsWrite(capsule.state, winner), true);
  assert.equal(await engineAllowsWrite(capsule.state, winner === "notes" ? "other" : "notes"), false);
});

test("plugin entry registers two tools and one listener directly and through loadPlugin", async () => {
  const direct = createPluginRegistry({ env: {} }); plugin(direct.api);
  assert.ok(direct.getTool("memory_search")); assert.ok(direct.getTool("memory_save")); assert.equal(direct.listListeners().length, 1);
  const context = { signal: new AbortController().signal, conversationId: "tool:c", capsule: ram("tool") };
  const save = direct.getTool("memory_save"); const search = direct.getTool("memory_search");
  assert.ok(save); assert.ok(search);
  const aborted = new AbortController(); aborted.abort();
  const abortedContext = { ...context, signal: aborted.signal, capsule: ram("aborted-tool") };
  await assert.rejects(save.execute({ text: "Remember canceled writes never persist" }, abortedContext), /aborted/i);
  await assert.rejects(search.execute({ query: "anything" }, abortedContext), /aborted/i);
  const cleanContext = { ...abortedContext, signal: new AbortController().signal };
  assert.deepEqual((await search.execute({ query: "canceled" }, cleanContext).then((result) => result.details) as { results: unknown[] }).results, []);
  assert.deepEqual(await save.execute({ text: 123 }, context), { text: "Saved: 123", details: { saved: true, origin: "owner" } });
  assert.deepEqual(await save.execute({ text: 123 }, context), { text: "Already remembered: 123", details: { saved: false, origin: "owner" } });
  const raw = `  Remember   normalized text ${"x".repeat(300)}  `;
  const actual = `Remember normalized text ${"x".repeat(300)}`.slice(0, 280);
  assert.deepEqual(await save.execute({ text: raw }, context), {
    text: `Saved: ${actual}`,
    details: { saved: true, origin: "owner" },
  });
  assert.deepEqual(await save.execute({ text: raw }, context), {
    text: `Already remembered: ${actual}`,
    details: { saved: false, origin: "owner" },
  });
  assert.equal((await search.execute({ query: "normalized" }, context).then((result) => result.details) as { results: { text: string }[] }).results[0]?.text, `tool:c — ${actual}`);
  const output = await search.execute({ query: "123", limit: "1" }, context);
  assert.match(output.text, /123/);
  assert.equal((output.details as { results: unknown[] }).results.length, 1);
  const loaded = createPluginRegistry({ env: {} });
  await loadPlugin(loaded, fileURLToPath(new URL("../plugins/tools/notes", import.meta.url)));
  assert.ok(loaded.getTool("memory_search")); assert.ok(loaded.getTool("memory_save")); assert.equal(loaded.listListeners().length, 1);

  const blockedRoot = await mkdtemp(join(tmpdir(), "zing-notes-tool-blocked-"));
  const blocked = await disk(blockedRoot, "blocked-tool");
  await blocked.state.write("memory/ENGINE", "other\n");
  await assert.rejects(
    save.execute({ text: "Remember this must not lie" }, { ...context, capsule: blocked }),
    /managed by another engine/,
  );
});
