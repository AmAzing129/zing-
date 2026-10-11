import type { ZingPlugin } from "zing";

const plugin: ZingPlugin = (zing) => {
  zing.registerChannel({
    id: "packaged",
    async start(signal) {
      signal.throwIfAborted();
    },
  });
};

export default plugin;
