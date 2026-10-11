import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("SIGTERM exits after cleanup even when an untracked handle remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "zing-lifecycle-"));
  const pluginPath = join(root, "sticky.ts");
  const stationPath = join(root, "station.yaml");
  const blueprintPath = join(root, "agent.yaml");
  await writeFile(
    pluginPath,
    `export default function (zing) {
  zing.registerChannel({
    id: "sticky",
    async start(signal) {
      const timer = setInterval(() => {}, 1000)
      console.log("LIFECYCLE_READY")
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
      void timer
    },
  })
}
`,
  );
  await writeFile(
    stationPath,
    `plugins:\n  - ${JSON.stringify(resolve("plugins/providers/xai"))}\nchannel: sticky\nprovider: xai\n`,
  );
  await writeFile(blueprintPath, "name: lifecycle\nmodel: grok-4.6\ntools: []\n");

  const child = spawn(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      "src/index.ts",
      "--station",
      stationPath,
      "--blueprint",
      blueprintPath,
      "--plugin",
      pluginPath,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ZING_HOME: join(root, "home") },
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });

  try {
    await waitForOutput(child, "LIFECYCLE_READY", 5_000);
    child.kill("SIGTERM");
    const exit = await waitForExit(child, 2_000);
    assert.deepEqual(exit, { code: 143, signal: null }, stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
    }
    await rm(root, { recursive: true, force: true });
  }
});

function waitForOutput(child: ChildProcessWithoutNullStreams, expected: string, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${expected}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Process exited before ${expected}: code=${String(code)} signal=${String(signal)}`));
    };
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      error ? reject(error) : resolveReady();
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error("Process did not exit after SIGTERM")), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}
