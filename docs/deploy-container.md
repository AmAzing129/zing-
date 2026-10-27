# Deploying Zing in OCI Containers

Run Zing as a generic OCI **background Worker**. It has no HTTP health endpoint, listens on no ports, and requires no published or mapped ports. The platform should use process liveness to determine whether the Worker is running.

See [deployment-contract.md](./deployment-contract.md) for the full operational boundaries. In particular, maintain one process, one Capsule writer, and one replica.

## Image Contents

The image must include Node.js `>=22.19.0`, the npm dependencies required for production execution, and the project code. `agent.yaml`, `station.yaml`, and the local plugins and skill directories they reference must also be bundled in the image or mounted at runtime as read-only volumes accessible to the process. Set the working directory to the project root so default configuration and relative plugin paths can be resolved.

The image's startup command should run:

```sh
npm start
```

Do not start a process manager or a second Zing process inside the container; let the container platform handle restarts.

## Environment Variables and Persistent Volumes

At a minimum, configure the credentials required by the selected provider and channel (see `.env.example`), and set:

```text
ZING_HOME=/zing
```

Mount a persistent, writable volume with POSIX filesystem semantics at `/zing`. Container image layers and ephemeral volumes lose the Capsule when an instance is replaced and must not be used for production persistence. Configuration and plugin mounts should generally be read-only; only `/zing` needs write access.

Common optional variables include `ZING_STATION`, `ZING_PLUGINS`, and provider/channel API tokens. Inject them through the platform's secrets mechanism rather than baking them into the image.

## Lifecycle

- Fix the replica count at **1**. Old and new replicas must not overlap while writing to the same volume during rolling updates. Use Recreate or stop-before-start semantics.
- The platform should send `SIGTERM` to the main process when stopping the container. Use `npm start` as the container command, without a shell wrapper that swallows signals.
- Zing's internal forced-exit limit is 60 seconds. Allow a grace period of at least 65 seconds before sending `SIGKILL`. The first 50 seconds are for draining the Channel; turns still running at that point are canceled, and the remaining time is used to record cancellation and close storage.
- Do not configure TCP/HTTP ports, Services, or HTTP probes. A platform that requires a listening port is unsuitable for the current runtime model.

`deploy/kubernetes/statefulset.yaml` demonstrates these constraints on Kubernetes. Other PaaS deployments should use equivalent single-replica background Worker and persistent-volume configurations.
