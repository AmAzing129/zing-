import type { ZingPlugin } from "zing";

const plugin: ZingPlugin = (zing) => {
  zing.registerChannel({
    id: "echo",
    async start(signal) {
      signal.throwIfAborted();
      const result = await zing.host.handleMessage({
        conversationId: zing.conversationId("echo", "test"),
        text: "hi",
      });
      console.log(result.text);
    },
  });
};

export default plugin;
