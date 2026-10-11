# Examples

This directory contains clients and focused usage examples, not Station plugins. Project and locally maintained plugin source lives in [`plugins/`](../plugins/), and [`station.yaml`](../station.yaml) explicitly selects which modules execute.

## Minimal stdio client

[`clients/stdio.ts`](clients/stdio.ts) starts the App Server, initializes JSON-RPC v1, opens a thread, starts one turn, and prints streamed text deltas:

```bash
./node_modules/.bin/tsx examples/clients/stdio.ts "Hello"
```

It uses the repository's `agent.yaml` and `station.yaml`. See [`docs/app-server.md`](../docs/app-server.md) for the protocol and [`plugins/README.md`](../plugins/README.md) for local plugin development.
