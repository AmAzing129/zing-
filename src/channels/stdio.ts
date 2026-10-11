import type { ZingPluginAPI } from "../plugin/types";

export type StdioChannelOptions = {
  message?: string;
  conversationKey?: string;
};

export function registerStdioChannel(zing: ZingPluginAPI, options: StdioChannelOptions = {}): void {
  zing.registerChannel({
    id: "stdio",
    async start(signal) {
      signal.throwIfAborted();
      const message = options.message?.trim();
      if (!message) {
        throw new Error("stdio channel requires a message (pass --once <text>)");
      }
      const result = await zing.host.handleMessage({
        conversationId: zing.conversationId("stdio", options.conversationKey ?? "once"),
        text: message,
      });
      signal.throwIfAborted();
      console.log(result.text || "(empty response)");
    },
  });
}
