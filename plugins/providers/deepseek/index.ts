import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type { ZingPluginAPI } from "zing";

export const DEEPSEEK_PLUGIN_ID = "deepseek";

export default function deepseek(zing: ZingPluginAPI) {
  zing.registerProvider({
    pluginId: DEEPSEEK_PLUGIN_ID,
    provider: deepseekProvider(),
    getApiKey: () => zing.env.DEEPSEEK_API_KEY?.trim() || undefined,
  });
}
