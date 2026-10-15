# 使用 OCI 容器部署 Zing

Zing 应作为通用 OCI **后台 Worker** 运行。它没有 HTTP 健康端点，不监听端口，也不需要发布或映射端口。平台应以进程存活状态判断 Worker 是否运行。

完整的运行边界见 [deployment-contract.md](./deployment-contract.md)。尤其要保持单进程、单 Capsule 写者和单副本。

## 镜像内容

镜像需要包含 Node.js `>=22.19.0`、生产运行所需 npm 依赖和项目代码。`agent.yaml`、`station.yaml` 及其引用的本地插件和技能目录也必须打包进镜像，或在运行时以进程可读的只读卷挂载。工作目录应设置为项目根目录，以便解析默认配置和相对插件路径。

镜像的启动命令应运行：

```sh
npm start
```

不要在容器中启动进程管理器或第二个 Zing 进程；由容器平台负责重启。

## 环境变量与持久卷

至少配置运行所选 provider/channel 所需的密钥（参见 `.env.example`），并设置：

```text
ZING_HOME=/zing
```

将一个持久、可写、支持 POSIX 文件语义的卷挂载到 `/zing`。容器镜像层和临时卷会在替换实例时丢失 Capsule，不可用于生产持久化。配置和插件挂载通常应为只读，只有 `/zing` 需要写权限。

常见可选变量包括 `ZING_STATION`、`ZING_PLUGINS` 以及 provider/channel 的 API token。应通过平台 Secret 注入，不要烘焙进镜像。

## 生命周期

- 副本数固定为 **1**；禁止滚动更新期间新旧副本重叠写入同一个卷。使用 Recreate/停止后启动语义。
- 平台停止容器时应向主进程发送 `SIGTERM`。让 `npm start` 成为容器命令，不要用会吞掉信号的 shell 包装器。
- Zing 内部的强制退出上限为 60 秒；平台应留出至少 65 秒的宽限期，超时后才可发送 `SIGKILL`。其中前 50 秒用于排空 Channel，届时仍在运行的 turn 会被取消，剩余时间用于记录取消并关闭存储。
- 不要配置 TCP/HTTP 端口、Service 或 HTTP 探针。若平台强制要求监听端口，它不适合当前运行模式。

`deploy/kubernetes/statefulset.yaml` 是这些约束的 Kubernetes 示例；其他 PaaS 应映射为等价的单副本后台 Worker 和持久卷配置。
