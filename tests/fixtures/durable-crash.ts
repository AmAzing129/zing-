import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createDurableAgent } from "../../src/durable";
import type { Tool } from "../../src/plugin/types";

const [directory, scenario] = process.argv.slice(2);
if (!directory) throw new Error("Missing fixture directory");
const sqlite = await openNodeSqliteStorage(join(directory, "durable.sqlite"));
const storage = new Proxy(sqlite, {
  get(target, key) {
    if (key === "commit") {
      const commit: typeof sqlite.commit = async (writes, context) => {
        const seq = await target.commit(writes, context);
        if (
          scenario === "failure" &&
          writes.some(
            (write) =>
              write.type === "submission" && write.value.status === "unanswered" && write.value.reason === "faulted",
          )
        ) {
          // Kill after SQLite commits the failure, before zing can persist the task's abort mark.
          process.kill(process.pid, "SIGKILL");
        }
        return seq;
      };
      return commit;
    }
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const tool: Tool = {
  name: "crash",
  description: "Crash during a tool",
  parameters: Type.Object({}),
  async execute() {
    process.kill(process.pid, "SIGKILL");
    return { text: "unreachable" };
  },
};
const agent = await createDurableAgent(
  {
    models,
    resolveModel: () => faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    getApiKey: () => undefined,
  },
  { name: "crash", model: faux.getModel().id, tools: [tool.name] },
  undefined,
  {
    storage,
    tools: [tool],
    limits: {
      maxModelTurns: scenario === "failure" ? 1 : 10,
      // "resume" leaves a run that the next start resumes rather than one already past its deadline.
      turnTimeoutMs: scenario === "observation" ? 2_000 : scenario === "resume" ? 60_000 : 500,
    },
    listeners: scenario === "observation" ? [async () => new Promise<void>(() => {})] : [],
  },
);
// Startup must fence all runs before an earlier idle thread can start recovery work.
await agent.openThread("idle:first");
await agent.openThread("idle:second");
if (scenario === "observation") {
  faux.setResponses([fauxAssistantMessage("earlier answer")]);
  await agent.handleMessage({ conversationId: "chat:crash", text: "earlier turn" });
}
faux.setResponses([fauxAssistantMessage([fauxToolCall(tool.name, {})], { stopReason: "toolUse" })]);
await agent.handleMessage({ conversationId: "chat:crash", text: "crash", senderId: "alice", requestId: "crash:1" });
throw new Error("Fixture did not reach its crash boundary");
