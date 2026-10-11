import "dotenv/config";

import {
  defaultBlueprint,
  findBlueprint,
  loadBlueprint,
  withBlueprintModel,
} from "./blueprint";
import { openFileCapsule } from "./capsule";
import { registerStdioChannel } from "./channels/stdio";
import { parseCli, usage } from "./cli";
import { loadConfig } from "./config";
import { zingHome } from "./env";
import { createZingHost, type ZingHost } from "./host";
import { selectChannel } from "./plugin/index";
import { runStdioAppServer } from "./protocol/index";
import { defaultStationConfig, findStationConfig, loadStationConfig } from "./station-config";

const SHUTDOWN_TIMEOUT_MS = 60_000;

async function main(): Promise<void> {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(usage());
    return;
  }

  const once = cli.onceMessage !== undefined;
  const home = zingHome();
  const stationPath = await findStationConfig({ explicit: cli.station, home });
  const stationConfig = stationPath ? await loadStationConfig(stationPath) : defaultStationConfig();
  const config = loadConfig(process.env, {
    station: stationConfig,
    channel: cli.mode === "app-server" ? undefined : once ? "stdio" : cli.channel,
    provider: cli.provider,
    capsulePath: cli.capsule,
    pluginPaths: cli.pluginPaths,
  });

  const shutdown = new AbortController();
  let host: ZingHost | undefined;
  let signalExitCode: number | undefined;
  const stop = (signal: NodeJS.Signals): void => {
    if (shutdown.signal.aborted) {
      return;
    }
    const exitCode = signal === "SIGINT" ? 130 : 143;
    signalExitCode = exitCode;
    process.exitCode = exitCode;
    setTimeout(() => process.exit(exitCode), SHUTDOWN_TIMEOUT_MS).unref();
    shutdown.abort();
    void host?.close().catch((error) => console.error("Zing host cleanup failed", error));
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    const blueprintPath = await findBlueprint({ explicit: cli.blueprint, home });
    const blueprint = withBlueprintModel(
      blueprintPath ? await loadBlueprint(blueprintPath) : defaultBlueprint(),
      config.model,
    );
    host = await createZingHost({
      blueprint,
      capsuleFactory: (candidate) => openFileCapsule({ blueprint: candidate, path: config.capsulePath, home }),
      pluginPaths: config.pluginPaths,
      provider: config.provider,
      env: process.env,
      configureRegistry: once
        ? (registry) => registerStdioChannel(registry.api, { message: cli.onceMessage })
        : undefined,
    });

    if (shutdown.signal.aborted) {
      return;
    }

    if (cli.mode === "app-server") {
      console.error(`Agent ${host.agent.name} ${host.agent.agentId} via app-server stdio`);
      await runStdioAppServer(
        host.agent,
        {
          agentId: host.agent.agentId,
          name: host.agent.name,
          modelId: host.agent.modelId,
        },
        { signal: shutdown.signal },
      );
      return;
    }

    const channel = selectChannel(host.registry, config.channel);
    console.log(`Agent ${host.agent.name} ${host.agent.agentId} via ${channel.id}`);
    await channel.start(shutdown.signal);
  } finally {
    try {
      await host?.close();
    } finally {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      if (signalExitCode !== undefined) {
        process.exit(signalExitCode);
      }
    }
  }
}

await main();
