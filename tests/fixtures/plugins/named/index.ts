import type { ZingPlugin } from "zing";

const plugin: ZingPlugin = (zing) => {
  zing.registerChannel({
    id: "named",
    async start(signal) {
      signal.throwIfAborted();
    },
  });
};

export default plugin;
