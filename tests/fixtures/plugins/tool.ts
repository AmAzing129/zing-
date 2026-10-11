import type { ZingPlugin } from "zing";

const plugin: ZingPlugin = (zing) => {
  zing.registerTool({
    name: "noop__tool",
    description: "No-op",
    parameters: {},
    execute: async () => ({ text: "" }),
  });
};

export default plugin;
