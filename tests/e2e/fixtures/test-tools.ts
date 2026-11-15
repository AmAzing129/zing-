import { appendFileSync } from "node:fs";

import { Type } from "@earendil-works/pi-ai";
import type { ZingPluginAPI } from "zing";

/** One line of ZING_E2E_TOOL_LOG: what a tool execution did, as the test reads it back. */
export type ToolLogEntry = { tool: string; event: "started" | "aborted"; input: Record<string, unknown> };

/** Tools whose executions a test can observe across process restarts. */
export default function testTools(zing: ZingPluginAPI) {
  const log = zing.requireEnv("ZING_E2E_TOOL_LOG");
  const record = (entry: ToolLogEntry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);

  zing.registerTool({
    name: "e2e__echo",
    description: "Return the given text.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(input) {
      record({ tool: "e2e__echo", event: "started", input });
      return { text: String(input.text) };
    },
  });

  zing.registerTool({
    name: "e2e__block",
    description: "Wait until the turn is canceled.",
    parameters: Type.Object({}),
    async execute(input, { signal }) {
      record({ tool: "e2e__block", event: "started", input });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      record({ tool: "e2e__block", event: "aborted", input });
      throw new Error("e2e__block aborted");
    },
  });
}
