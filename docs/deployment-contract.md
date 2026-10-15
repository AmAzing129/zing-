# Zing 部署契约

本文定义当前正式支持的生产部署边界。部署模板是不同平台上的同一运行模型，而不是不同的分布式架构。

## 支持的运行模型

- **一个常驻 Node.js 进程运行一个 Agent 和一个 Capsule。** Node.js 必须为 `22.19.0` 或更高版本。
- **一个 Capsule 只能有一个写者。** 不得让两个进程或副本共享并写入同一个 `ZING_HOME`；文件锁、共享卷或调度亲和性都不能把多写者变成受支持配置。
- `ZING_HOME` 必须位于可靠的 **POSIX 持久存储**上，并在重启、重新部署和主机维护后保留。不要使用容器可写层或临时目录。
- 备份 `ZING_HOME` 时应先停止进程，或使用能够提供一致时间点快照的存储。恢复时仍只能启动一个写者。
- 选择 `runtime: durable` 时，Capsule 目录中还会有 `durable.sqlite`（及其 `-wal`、`-shm` 文件）。它使用 Node 内置的 `node:sqlite`，同样只允许一个写者；备份时需连同这些文件一起保存。
- 云数据库只是外部工具或数据源，**不是 Zing 的计算环境，也不能代替 `ZING_HOME`**。当前不支持用 Postgres 存储 Capsule。

此工作单元不提供 Webhook、Serverless、Postgres 或横向扩展方案。Zing 是后台常驻进程；平台必须允许它持续运行并优雅停止。

## 配置与密钥

模型、Channel 和插件所需的密钥通过环境变量注入；可参考 `.env.example`。不要把生产密钥提交到仓库或镜像。

`agent.yaml`、`station.yaml`、`station.yaml` 引用的本地插件以及 `agent.yaml` 引用的技能目录必须：

1. 打包进部署制品/镜像；或
2. 通过进程可读的只读挂载提供。

所有相对路径均相对于工作目录解析，因此工作目录中应包含这些配置，或者显式设置 `ZING_STATION` 并使用正确路径。持久状态单独写入 `ZING_HOME`。

## 平台 Profile

### VPS / Linux（systemd）

使用 `deploy/systemd/zing.service`。它假设 checkout 位于 `/opt/zing`，依赖已安装，专用系统用户 `zing` 可以读取代码，并拥有 `/var/lib/zing`。将密钥写入仅该用户和管理员可读的 `/etc/zing/zing.env`，然后启用一个 service 实例。不要再用 cron、另一个 service 或手工命令启动第二个写者。

### macOS（launchd）

使用 `deploy/launchd/com.zing.agent.plist`。安装前必须替换其中全部 `/ABSOLUTE/PATH/...` 占位符，尤其是工作目录、Node 可执行文件和 `tsx` CLI 路径；launchd 不会读取交互式 shell 的 PATH 或环境变量。可在工作目录放置权限为 `0600`、不提交到 Git 的 `.env`，或把密钥加入受限权限 plist 的 `EnvironmentVariables`。模板把 stdout/stderr 写到工作目录下的日志文件，生产使用时可按本机日志策略调整。只加载一个 plist 实例，并确保 `ZING_HOME` 位于持久的本地 POSIX 文件系统。

### PaaS

使用后台 Worker（不是 Web Process、Function 或定时任务）部署，细节见 [deploy-container.md](./deploy-container.md)。平台必须同时支持：

- 无 HTTP 监听端口的长期运行进程；
- 可挂载到 `/zing` 的持久 POSIX 卷；
- 单副本运行和 SIGTERM 优雅停止。

不能提供上述能力的平台不属于当前支持范围。

### Kubernetes

使用 `deploy/kubernetes/statefulset.yaml` 作为起点。StatefulSet 固定 `replicas: 1`，通过 PVC 挂载 `/zing`，且不创建 Service 或端口。替换镜像占位符并创建模板引用的 Secret 后再部署。模板使用 `OnDelete`；更新模板后删除旧 Pod，由 StatefulSet 在旧 Pod 终止后创建替代 Pod。不要强制删除尚未确认停止的 Pod，也不得临时同时运行两个写者。

Kubernetes 并不会让 Capsule 成为分布式存储。不要扩容副本，也不要让其他 workload 挂载同一 PVC 进行写入。
