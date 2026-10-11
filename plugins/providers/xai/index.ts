import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import type { ZingPluginAPI } from "zing";

export const XAI_PLUGIN_ID = "xai";

export default function xai(zing: ZingPluginAPI) {
  zing.registerProvider({
    pluginId: XAI_PLUGIN_ID,
    provider: xaiProvider(),
    getApiKey: () => zing.env.XAI_API_KEY?.trim() || undefined,
  });
}
