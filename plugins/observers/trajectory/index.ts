import type { ZingPluginAPI } from "zing";

import { appendRecord, toRecord, trajectoryDir } from "./trajectory";

export const TRAJECTORY_PLUGIN_ID = "trajectory";

export default function trajectory(zing: ZingPluginAPI) {
  const dir = trajectoryDir(zing.env);
  // Listener calls are serial, so lines land in order without a queue of our own.
  zing.onConversation((event) => appendRecord(dir, toRecord(event)));
}
