# Zing Deployment Contract

This document defines the boundaries of currently supported production deployments. The deployment templates implement the same runtime model on different platforms, not different distributed architectures.

## Supported Runtime Model

- **One resident Node.js process runs one Agent and one Capsule.** Node.js must be version `22.19.0` or later.
- **Each Capsule must have only one writer.** Do not let two processes or replicas share and write to the same `ZING_HOME`; file locks, shared volumes, and scheduling affinity do not make multiple writers a supported configuration.
- `ZING_HOME` must reside on reliable **persistent POSIX storage** and survive restarts, redeployments, and host maintenance. Do not use a container's writable layer or a temporary directory.
- Before backing up `ZING_HOME`, stop the process or use storage that provides consistent point-in-time snapshots. After restoring, start only one writer.
- The default is `runtime: durable`, which stores `durable.sqlite` (and its `-wal` and `-shm` files) in the Capsule directory. It uses Node's built-in `node:sqlite` and likewise permits only one writer; include these files in backups.
- A cloud database is only an external tool or data source, **not an execution environment for Zing or a replacement for `ZING_HOME`**. Storing Capsules in Postgres is not currently supported.

The current implementation does not provide webhook, serverless, Postgres, or horizontal-scaling deployment options. Zing is a resident background process; the platform must allow it to run continuously and shut down gracefully.

## Configuration and Secrets

Supply credentials for models, Channels, and plugins through environment variables; see `.env.example`. Do not commit production secrets to the repository or bake them into an image.

`agent.yaml`, `station.yaml`, local plugins referenced by `station.yaml`, and skill directories referenced by `agent.yaml` must be either:

1. Bundled in the deployment artifact or image; or
2. Provided through read-only mounts accessible to the process.

All relative paths are resolved against the working directory, so it should contain these configuration files, or you must explicitly set `ZING_STATION` and use the correct paths. Persistent state is stored separately under `ZING_HOME`.

## Platform Profiles

### VPS / Linux (systemd)

Use `deploy/systemd/zing.service`. It assumes the checkout is at `/opt/zing`, dependencies are installed, and the dedicated system user `zing` can read the code and owns `/var/lib/zing`. Write secrets to `/etc/zing/zing.env`, readable only by that user and administrators, then enable one service instance. Do not start a second writer through cron, another service, or a manual command.

### macOS (launchd)

Use `deploy/launchd/com.zing.agent.plist`. Before installation, replace every `/ABSOLUTE/PATH/...` placeholder, especially the working directory, Node executable, and `tsx` CLI paths; launchd does not read your interactive shell's PATH or environment variables. You can place a `.env` file with permissions `0600` in the working directory and keep it out of Git, or add secrets to `EnvironmentVariables` in a plist with restricted permissions. The template writes stdout and stderr to log files in the working directory; adjust this to your local logging policy for production use. Load only one plist instance and ensure `ZING_HOME` resides on a persistent local POSIX filesystem.

### PaaS

Deploy as a background Worker, not a Web Process, Function, or scheduled job. See [deploy-container.md](./deploy-container.md) for details. The platform must support all of the following:

- A long-running process without an HTTP listening port;
- A persistent POSIX volume mountable at `/zing`;
- Single-replica operation and graceful shutdown on SIGTERM.

Platforms that cannot provide these capabilities are not currently supported.

### Kubernetes

Use `deploy/kubernetes/statefulset.yaml` as a starting point. The StatefulSet fixes `replicas: 1`, mounts `/zing` through a PVC, and creates no Service or ports. Replace the image placeholder and create the Secret referenced by the template before deploying. The template uses `OnDelete`: after updating it, delete the old Pod so the StatefulSet creates a replacement after the old Pod terminates. Do not force-delete a Pod that has not been confirmed stopped, and never run two writers simultaneously, even temporarily.

Kubernetes does not turn a Capsule into distributed storage. Do not scale out replicas or allow other workloads to mount the same PVC for writing.
