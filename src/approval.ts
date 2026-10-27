import type { Tool } from "./plugin/types";

/**
 * Which tool calls wait for the user's yes: "writes" for every tool not declared read-only, or exact tool names.
 * Absent, no call waits.
 */
export type ApprovalPolicy = "writes" | readonly string[];

/** The blueprint's tools, with the ones its policy names asking the turn's approver before every call. */
export function withApproval(tools: readonly Tool[], policy: ApprovalPolicy | undefined): Tool[] {
  if (policy === undefined) return [...tools];
  const asks = (tool: Tool) => (policy === "writes" ? tool.readOnly !== true : policy.includes(tool.name));
  return tools.map((tool) => (asks(tool) ? gate(tool) : tool));
}

function gate(tool: Tool): Tool {
  return {
    ...tool,
    async execute(input, context) {
      // The model reads these errors as the call's result, so they say what happened and that nothing ran.
      if (!context.approve) {
        throw new Error(
          `${tool.name} needs the user's approval, which this conversation cannot ask for. It did not run.`,
        );
      }
      const approved = await context.approve({ tool: tool.name, description: tool.description, input }, context.signal);
      context.signal.throwIfAborted();
      if (!approved) {
        throw new Error(`The user declined ${tool.name}. It did not run.`);
      }
      return tool.execute(input, context);
    },
  };
}
