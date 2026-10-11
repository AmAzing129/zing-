export type Cli = {
  help: boolean;
  mode: "channel" | "app-server";
  onceMessage?: string;
  channel?: string;
  blueprint?: string;
  capsule?: string;
  station?: string;
  provider?: string;
  pluginPaths: string[];
};

export function parseCli(argv: string[]): Cli {
  const pluginPaths: string[] = [];
  let help = false;
  let mode: Cli["mode"] = "channel";
  let onceMessage: string | undefined;
  let channel: string | undefined;
  let blueprint: string | undefined;
  let capsule: string | undefined;
  let station: string | undefined;
  let provider: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      break;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "app-server") {
      if (mode === "app-server") {
        throw new Error("app-server specified more than once");
      }
      mode = "app-server";
      continue;
    }
    if (arg === "--once") {
      onceMessage = argv.slice(index + 1).join(" ");
      break;
    }
    if (arg === "--plugin" || arg === "-e") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      pluginPaths.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--plugin=")) {
      const value = arg.slice("--plugin=".length);
      if (!value) {
        throw new Error("--plugin requires a path");
      }
      pluginPaths.push(value);
      continue;
    }
    if (arg === "--channel") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--channel requires an id");
      }
      channel = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--channel=")) {
      channel = arg.slice("--channel=".length);
      continue;
    }
    if (arg === "--agent" || arg === "-a" || arg === "--blueprint" || arg === "--definition") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      blueprint = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) {
      blueprint = arg.slice("--agent=".length);
      continue;
    }
    if (arg.startsWith("--blueprint=")) {
      blueprint = arg.slice("--blueprint=".length);
      continue;
    }
    if (arg.startsWith("--definition=")) {
      blueprint = arg.slice("--definition=".length);
      continue;
    }
    if (arg === "--capsule") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--capsule requires a path");
      }
      capsule = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--capsule=")) {
      capsule = arg.slice("--capsule=".length);
      continue;
    }
    if (arg === "--station") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--station requires a path");
      }
      station = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--station=")) {
      const value = arg.slice("--station=".length);
      if (!value) {
        throw new Error("--station requires a path");
      }
      station = value;
      continue;
    }
    if (arg === "--provider") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--provider requires an id");
      }
      provider = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--provider=")) {
      provider = arg.slice("--provider=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (mode === "app-server" && onceMessage !== undefined) {
    throw new Error("app-server cannot be combined with --once");
  }
  if (mode === "app-server" && channel !== undefined) {
    throw new Error("app-server cannot be combined with --channel");
  }

  return { help, mode, onceMessage, channel, blueprint, capsule, station, provider, pluginPaths };
}

export function usage(): string {
  return [
    "Usage: zing [app-server] [options]",
    "",
    "  app-server              Run the JSON-RPC v1 server over stdio",
    "  --plugin, -e <path>     Load a channel, tool, provider, or memory plugin (repeatable)",
    "  --channel <id>          Channel to start",
    "  --provider <id>         Model provider, if several can serve the model",
    "  --blueprint, -a <path>  The kind (default: ./agent.yaml or ~/.zing/agent.yaml)",
    "  --capsule <path>        This one (default: ~/.zing/capsules/<name>)",
    "  --station <path>        Local plugin config (default: ./station.yaml or $ZING_HOME/station.yaml)",
    "  --once <message>        Run once on stdio and exit",
    "  --help, -h              Show this help",
    "",
    "ZING_PLUGINS and repeatable --plugin flags append temporary local plugin paths.",
    "Blueprint is the kind. Capsule is this one. Station is where it docks.",
  ].join("\n");
}
