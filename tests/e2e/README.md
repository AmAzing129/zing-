# End-to-end tests

```bash
npm run test:e2e
```

Each test starts the real station, `src/index.ts`, as a child process in a temporary `ZING_HOME` and drives it only through public interfaces: the App Server's JSON-RPC over stdio, `--once`, signals, and stdin EOF. Plugins, capsule storage, the durable runtime, and skills are the real ones. Only the model is replaced, by [`fixtures/scripted-model.ts`](fixtures/scripted-model.ts), so the tests need no API keys or network.

The station runs outside the repository with a minimal environment, so a local `.env` and variables such as `XAI_API_KEY`, `ZING_PLUGINS`, or `MODEL` cannot change a result.

## Writing a scenario

```ts
const station = await createStation(t, {
  tools: ["memory_save"],              // the blueprint allowlist
  plugins: ["plugins/tools/notes"],    // repository plugins to enable
  script: {
    "remember tea": [
      { toolCalls: [{ name: "memory_save", arguments: { text: "Likes tea." } }] },
      { text: "Saved." },
    ],
  },
});
const server = await station.start();          // spawns `zing app-server` and initializes
const turn = await server.runTurn("chat:1", "remember tea");
```

- **Script.** A turn's nth model request gets the nth step listed under its user text: `{ text }`, `{ toolCalls }`, or `{ error }`. Keying by text keeps concurrent threads and resumed turns deterministic. A request with no step fails its turn and names the missing prompt.
- **What the model saw.** `station.modelRequests(prompt)` returns each request's visible tools, system prompt, and messages. Use it to check allowlists, history after a restart or reset, and tool results.
- **Test tools.** `e2e__echo` returns its input. `e2e__block` waits until its turn is aborted. Both record their executions in `station.toolLog()`, which survives restarts.
- **Process control.** `server.close()` ends stdin. `server.kill(signal)` delivers a real signal to the station process. `station.start()` again restarts it on the same capsule. Both `close()` and `kill()` fail if stdout carried anything other than JSON-RPC.

Every wait times out after 15 seconds and includes the station's stderr in the failure.
