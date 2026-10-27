import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";

import type { Blueprint } from "../src/blueprint";
import type { ApprovalRequest } from "../src/plugin/index";
import { createMemoryCapsule } from "../src/capsule";
import { createZingHost } from "../src/host";

test("host closes acquired storage on constructor failure and preserves cleanup errors", async () => {
  for (const failsCleanup of [false, true]) {
    const storage = new MemoryStorage();
    let closes = 0;
    const cleanupError = new Error("storage cleanup failed");
    storage.close = async () => {
      closes++;
      if (failsCleanup) throw cleanupError;
    };
    const faux = fauxProvider({ models: [{ id: "host-model" }] });
    await assert.rejects(createZingHost({
      blueprint: { name: "broken", tools: [] },
      capsuleFactory: async () => createMemoryCapsule({ blueprintName: "broken" }),
      durableStorage: async () => storage,
      configureRegistry(registry) {
        registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
      },
    }), (error: unknown) => {
      if (failsCleanup) {
        assert.ok(error instanceof AggregateError);
        assert.match(String(error.errors[0]), /has no model/);
        assert.strictEqual(error.errors[1], cleanupError);
      } else {
        assert.match(String(error), /has no model/);
      }
      return true;
    });
    assert.equal(closes, 1);
  }
});

test("createZingHost injects a capsule factory and closes idempotently", async () => {
  const faux = fauxProvider({ models: [{ id: "host-model" }] });
  const blueprint: Blueprint = { name: "host-test", model: "host-model", tools: [] };
  const capsule = createMemoryCapsule({ blueprintName: blueprint.name, agentId: "agt_host" });
  let requested: Blueprint | undefined;
  const host = await createZingHost({
    blueprint,
    capsuleFactory: async (candidate) => {
      requested = candidate;
      return capsule;
    },
    configureRegistry(registry) {
      registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
    },
  });

  assert.strictEqual(requested, blueprint);
  assert.equal(host.agent.agentId, "agt_host");
  const closing = host.close();
  assert.strictEqual(host.close(), closing);
  await closing;
  assert.throws(() => host.agent.startTurn({ threadId: "closed", text: "nope" }), /shutting down/);
});

test("createZingHost runs the durable runtime over the storage it is given", async () => {
  const faux = fauxProvider({ models: [{ id: "host-model" }] });
  const blueprint: Blueprint = { name: "durable-host", model: "host-model", tools: ["echo"] };
  const capsule = createMemoryCapsule({ blueprintName: blueprint.name, agentId: "agt_durable" });
  const conversations: string[] = [];
  let storageFor: unknown;
  const host = await createZingHost({
    blueprint,
    capsuleFactory: async () => capsule,
    durableStorage: async (candidate) => {
      storageFor = candidate;
      return new MemoryStorage();
    },
    configureRegistry(registry) {
      registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
      registry.api.registerTool({
        name: "echo",
        description: "Echo",
        parameters: Type.Object({ text: Type.String() }),
        execute: async (input, context) => {
          conversations.push(context.conversationId);
          return { text: String(input.text) };
        },
      });
    },
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("echoed"),
  ]);

  assert.strictEqual(storageFor, capsule);
  assert.equal(host.agent.agentId, "agt_durable");
  assert.equal((await host.agent.handleMessage({ conversationId: "telegram:9", text: "echo hi" })).text, "echoed");
  assert.deepEqual(conversations, ["telegram:9"]);
  await host.close();
  assert.throws(() => host.agent.startTurn({ threadId: "closed", text: "nope" }), /shutting down/);
});

test("createZingHost loads the blueprint's skills before it opens the capsule", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-host-skills-"));
  await mkdir(join(root, "trip"));
  await writeFile(join(root, "trip", "SKILL.md"), "---\nname: trip\ndescription: Plan trips.\n---\nPack light.\n");
  await mkdir(join(root, "broken"));
  await writeFile(join(root, "broken", "SKILL.md"), "no frontmatter\n");
  const faux = fauxProvider({ models: [{ id: "host-model" }] });
  let opened = 0;
  const create = (skills: string[]) =>
    createZingHost({
      blueprint: { name: "skilled", model: "host-model", tools: [], skills },
      capsuleFactory: async () => (opened++, createMemoryCapsule({ blueprintName: "skilled" })),
      configureRegistry(registry) {
        registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
      },
    });

  await assert.rejects(create([join(root, "trip"), join(root, "broken")]), /broken\/SKILL\.md: must start with YAML frontmatter/);
  assert.equal(opened, 0);

  const host = await create([join(root, "trip")]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("skill", { name: "trip" })], { stopReason: "toolUse" }),
    (context) => fauxAssistantMessage(context.messages.at(-1)?.role === "toolResult" ? "loaded" : "missing"),
  ]);
  assert.equal((await host.agent.handleMessage({ conversationId: "chat:trip", text: "plan" })).text, "loaded");
  const entries = (await host.agent.readThread("chat:trip")).entries;
  assert.deepEqual(entries[2]?.type === "toolResult" && entries[2].content, [{ type: "text", text: "Pack light." }]);
  await host.close();
});

test("createZingHost checks the blueprint's subagents before it opens the capsule", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-host-subagents-"));
  await writeFile(join(root, "researcher.md"), "---\nname: researcher\ndescription: Research.\ntools: [web_search]\n---\nSearch.\n");
  await writeFile(join(root, "elsewhere.md"), "---\nname: elsewhere\ndescription: Research.\nmodel: missing-model\n---\nSearch.\n");
  const faux = fauxProvider({ models: [{ id: "host-model" }] });
  let opened = 0;
  const create = (tools: string[], agents: string[]) =>
    createZingHost({
      blueprint: { name: "lead", model: "host-model", tools, agents: agents.map((file) => join(root, file)) },
      capsuleFactory: async () => (opened++, createMemoryCapsule({ blueprintName: "lead" })),
      configureRegistry(registry) {
        registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
        registry.api.registerTool({
          name: "web_search",
          description: "Search",
          parameters: Type.Object({ query: Type.String() }),
          execute: async () => ({ text: "MIT" }),
        });
      },
    });

  await assert.rejects(create([], ["researcher.md"]), /researcher\.md: tools web_search are not in the main agent's tools/);
  assert.equal(opened, 0);
  await assert.rejects(create([], ["elsewhere.md"]), /Unknown model: missing-model/);

  const host = await create(["web_search"], ["researcher.md"]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("subagent", { name: "researcher", task: "Find the license." })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("web_search", { query: "license" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("It is MIT."),
    (context) => fauxAssistantMessage(context.messages.at(-1)?.role === "toolResult" ? "delegated" : "missing"),
  ]);
  assert.equal((await host.agent.handleMessage({ conversationId: "chat:lead", text: "license?" })).text, "delegated");
  await host.close();
});

test("createZingHost disposes loaded plugins when construction fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-host-cleanup-"));
  const key = `zingHostCleanup${Date.now()}${Math.random()}`;
  (globalThis as Record<string, unknown>)[key] = 0;
  await writeFile(
    join(root, "plugin.ts"),
    `export default function () { return () => { globalThis[${JSON.stringify(key)}] += 1 } }`,
  );

  try {
    await assert.rejects(
      createZingHost({
        blueprint: { name: "broken-host", model: "missing", tools: [] },
        capsuleFactory: async () => createMemoryCapsule({ blueprintName: "broken-host" }),
        pluginPaths: ["./plugin.ts"],
        cwd: root,
      }),
      /No provider plugin loaded/,
    );
    assert.equal((globalThis as Record<string, unknown>)[key], 1);
  } finally {
    delete (globalThis as Record<string, unknown>)[key];
  }
});

test("tools the approval policy names run only after the sender says yes, in both runtimes", async () => {
  for (const durable of [false, true]) {
    const faux = fauxProvider({ models: [{ id: "host-model" }] });
    let ran: string[] = [];
    const blueprint: Blueprint = { name: "approving", model: "host-model", tools: ["read", "write"], approval: "writes" };
    const host = await createZingHost({
      blueprint,
      capsuleFactory: async () => createMemoryCapsule({ blueprintName: blueprint.name }),
      ...(durable ? { durableStorage: async () => new MemoryStorage() } : {}),
      configureRegistry(registry) {
        registry.api.registerProvider({ pluginId: "fake", provider: faux.provider });
        for (const [name, readOnly] of [["read", true], ["write", false]] as const) {
          registry.api.registerTool({
            name,
            description: `${name} things`,
            parameters: Type.Object({ value: Type.String() }),
            readOnly,
            execute: async (input) => {
              ran.push(`${name}:${String(input.value)}`);
              return { text: "done" };
            },
          });
        }
      },
    });
    // The model calls read and write, then repeats what the write call returned.
    const turn = async (threadId: string, approve?: (request: ApprovalRequest) => Promise<boolean>) => {
      ran = [];
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("read", { value: "a" }), fauxToolCall("write", { value: "b" })], {
          stopReason: "toolUse",
        }),
        (context) => {
          const result = [...context.messages].reverse().find((message) => message.role === "toolResult" && message.toolName === "write");
          const text = result?.role === "toolResult" ? result.content.map((block) => (block.type === "text" ? block.text : "")).join("") : "";
          return fauxAssistantMessage(text);
        },
      ]);
      return (await host.agent.handleMessage({ conversationId: threadId, text: "go", ...(approve ? { approve } : {}) })).text;
    };

    const asked: ApprovalRequest[] = [];
    const declined = await turn("chat:declined", async (request) => (asked.push(request), false));
    assert.deepEqual(asked, [{ tool: "write", description: "write things", input: { value: "b" } }], `durable=${durable}`);
    assert.match(declined, /The user declined write\. It did not run\./);
    assert.deepEqual(ran, ["read:a"]);

    assert.equal(await turn("chat:approved", async () => true), "done");
    assert.deepEqual(ran.sort(), ["read:a", "write:b"]);

    assert.match(await turn("chat:unattended"), /needs the user's approval, which this conversation cannot ask for/);
    assert.deepEqual(ran, ["read:a"]);
    await host.close();
  }
});
