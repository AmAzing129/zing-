# Zing App Server v1 实现设计

> 状态：v1 已实现。本文同时记录实现前基线、最终架构、协议与演进边界。

## 目标

Zing 负责 agent 的身份、会话、记忆、工具和运行；客户端只负责交互方式。任何人都可以实现 Web、桌面、CLI、Telegram、Slack 等客户端，而不需要修改 Zing，也不需要采用 Zing 指定的 UI 框架。

v1 必须做到：

- 没有 UI 依赖，协议本身不定义组件、布局或样式。插件可以通过插件方法把自己的界面资源原样交给客户端，例如 MCP Apps 的 `ui://` HTML（见下文），渲染完全由客户端负责。
- 进程内 Channel 和进程外客户端共用同一个 runtime 行为。
- 客户端能收到文本增量、工具状态和 turn 最终状态。
- 会话持久化、同会话串行执行、取消和 reset 有确定语义。
- Zing 不依赖 AG-UI、ACP 或其他 agent-to-UI 协议；以后可以在核心之外提供适配器。
- 不直接暴露 `@earendil-works/pi-agent-core` 的类型或事件。

## 实现前基线

当前调用链如下：

```text
Channel.start(signal)
    -> ConversationHost.handleMessage
        -> createAgent 中按 conversationId 排队
            -> Conversation.prompt
                -> PiAgent.prompt
                -> Capsule 追加 JSONL transcript
        <- Promise<AgentResult>
    <- Channel 发送最终文本
```

主要边界：

- `src/plugin/types.ts`：`ConversationHost` 只有 `handleMessage` 和 `resetConversation`。
- `src/agent.ts`：按 `conversationId` 缓存 `Conversation`，同一会话通过 `pending` 串行执行，并将 Pi message/tool 事件映射到 runtime 事件。
- `src/capsule.ts`：保存 agent identity，并负责加载、追加和 reset 会话。
- `src/transcript.ts`：会话以 JSONL 保存，当前路径由 `channel:localId` 映射而来。
- `src/index.ts`：每个进程选择并启动一个 Channel。
- `plugins/channels/telegram/index.ts`：Channel 直接调用进程内 `ConversationHost`，等待完整结果后回复。

已有能力：

- agent identity 和会话历史可跨进程恢复。
- 不同 conversation 相互隔离。
- 同一 conversation 的消息按到达顺序执行。
- 单个失败不会阻塞后续消息。
- Channel、provider、tools 和 conversation observers 都由插件提供。

v1 需要补齐的缺口：

- 没有稳定的流式 runtime API。
- 客户端看不到文本增量、通用工具生命周期和 turn 状态。
- 没有取消、thread read/list 或断线后的状态对账接口。
- conversation ID 同时承担领域 ID 和存储路径约定。
- `resetConversation` 没有进入同一会话的执行队列。若它与活动 turn 重叠，活动 turn 可能在 reset 标记之后追加消息。
- 进程在写最后一行 JSONL 时崩溃，可能留下截断行；当前解析会使整个会话无法加载。

## 评审结论

不采用“协议就是核心”的设计。核心先定义与 transport 无关的 Zing Runtime，JSON-RPC 只是它的一个薄适配器。

```text
                         +-------------------+
Telegram Channel ------> |                   |
stdio --once ----------> |   Zing Runtime    | ----> Pi Agent
                         |                   | ----> Capsule
JSON-RPC stdio --------> |                   | ----> Plugins
future WebSocket ------> |                   |
                         +-------------------+
                                  ^
                                  |
                     optional AG-UI / ACP adapter
```

选择这个边界的原因：

1. 当前 `ConversationHost` 已经是进程内领域接口的雏形，可以渐进扩展。
2. Channel 和测试不需要经过序列化再调用同一进程。
3. Runtime 事件同时隔离 Pi，实现未来替换底层 agent core 时不影响客户端。
4. JSON-RPC、stdio、WebSocket、AG-UI、ACP 都只是 transport 或兼容层，可以独立替换。

v1 引入 **Thread** 和 **Turn**，但不复制 Codex 的通用 Item 体系：

- Thread：持久会话，对应当前 conversation。
- Turn：一次用户输入及其引发的完整 agent 工作。取消、排队和事件关联都依赖稳定的 `turnId`。
- Message 和 Tool：v1 的两类具体事件。以后需要新的工作单元时，以新增事件扩展，不预先设计通用 Item 联合类型。

## Runtime 领域接口

以下是目标形状，不要求逐字采用这些类型名：

```ts
type ThreadId = string;
type TurnId = string;

type TurnInput = {
  threadId: ThreadId;
  text: string;
  senderId?: string;
};

type RuntimeEvent =
  | { type: "turn/started"; threadId: ThreadId; turnId: TurnId }
  | {
      type: "message/delta";
      threadId: ThreadId;
      turnId: TurnId;
      messageId: string;
      delta: string;
    }
  | {
      type: "message/completed";
      threadId: ThreadId;
      turnId: TurnId;
      messageId: string;
      text: string;
    }
  | {
      type: "tool/started";
      threadId: ThreadId;
      turnId: TurnId;
      callId: string;
      name: string;
      input?: unknown;
    }
  | {
      type: "tool/completed";
      threadId: ThreadId;
      turnId: TurnId;
      callId: string;
      name: string;
      isError: boolean;
      details?: unknown;
    }
  | {
      type: "turn/completed";
      threadId: ThreadId;
      turnId: TurnId;
      status: "completed" | "failed" | "canceled";
      result?: AgentResult;
      error?: { message: string };
    };

type TurnHandle = {
  turnId: TurnId;
  completed: Promise<AgentResult>;
  cancel: () => void;
  subscribe: (listener: (event: RuntimeEvent) => void) => () => void;
};

type AgentRuntime = {
  openThread: (threadId?: ThreadId) => Promise<{ threadId: ThreadId; created: boolean }>;
  readThread: (threadId: ThreadId) => Promise<ThreadSnapshot>;
  listThreads: (options?: ListThreadsOptions) => Promise<ThreadPage>;
  startTurn: (input: TurnInput) => TurnHandle;
  cancelTurn: (threadId: ThreadId, turnId: TurnId) => Promise<void>;
  resetThread: (threadId: ThreadId) => Promise<void>;
};
```

实现约束：

- `TurnHandle` 是热运行句柄：是否订阅事件不能决定 turn 是否执行。
- 事件监听器不能阻塞 agent loop；transport 写入必须与 Pi 的同步事件回调解耦。
- `turn/completed` 只在本 turn 产生的 transcript 已持久化后发出。
- `message/completed` 和 `turn/completed` 中的最终内容是权威状态；delta 只是实时体验。
- `AgentResult = { text: string }`；现有 Channel 可以不消费任何流式事件。

### Pi 事件映射

Runtime 是 Pi 的防腐层，只在 `src/agent.ts` 内进行以下映射：

| Pi 事件 | Runtime 事件 |
| --- | --- |
| 外层 `PiAgent.prompt` 真正开始执行 | `turn/started` |
| `message_update` 中的 `text_delta` | `message/delta` |
| assistant `message_end` | `message/completed` |
| `tool_execution_start` | `tool/started` |
| `tool_execution_end` | `tool/completed` |
| prompt 成功、报错或 abort，并完成持久化 | `turn/completed` |

Pi 的 `turn_start` / `turn_end` 是一次模型循环；一个 Zing Turn 内可能因为工具调用发生多次模型循环，因此不能直接映射为 Zing Turn。
Pi 的 `tool_execution_update` 暂不进入 v1，避免把结构不稳定的底层 partial result 变成公共协议承诺。

## Thread 和历史

### Thread ID

- Runtime 将 `threadId` 当作不透明字符串，不解析其中的 channel 含义。
- `thread/open` 未提供 ID 时，由服务端生成，例如 `thr_<uuid>`。
- 消息系统可以提供稳定且带命名空间的 ID，例如 `telegram:12345`，从而不必维护额外映射表。
- 客户端提供的 ID 最多 80 UTF-8 bytes、禁止控制字符，并由 Capsule 安全编码为路径。
- 当前 `channel:localId` 文件布局继续兼容；它降级为 Capsule 的存储细节，不再是公共领域规则。

### 历史模型

`thread/read` 返回公共 `ThreadSnapshot`，包含最后一次 reset 之后的 user、assistant 和 tool-result 历史。它与当前 `TranscriptEvent` 语义对应，但公共协议类型不能直接 alias 存储类型：

- transcript 的 `v`、路径和 reset marker 是存储细节。
- 公共历史 DTO 只表达消息、工具结果、时间和必要模型信息。
- 存储格式升级不能被迫成为协议破坏性升级。
- 协议字段升级也不能要求重写已有 transcript。

Capsule 已增加 ensure/read/list 能力；Pi 恢复仍使用现有 `loadConversation`，客户端读取则经过公共 DTO 转换。

## Zing Protocol v1

### Envelope 和 transport

- 使用标准 JSON-RPC 2.0，保留 `"jsonrpc": "2.0"` 字段。
- 首发 transport 是 stdio，每行一个完整 JSON 对象（JSONL）。
- stdout 只能写协议消息；日志和诊断必须写 stderr。
- WebSocket 后续复用同一个 dispatcher，每个 text frame 一个 JSON-RPC 消息。
- v1 不依赖任何 JSON-RPC framework；dispatcher 只需要请求校验、方法路由、response 和 notification。

### 初始化

每条连接必须先调用 `initialize`：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": {
      "name": "my-client",
      "version": "0.1.0"
    }
  }
}
```

响应返回协商后的版本、agent identity 和 capabilities。初始化之前的其他方法必须失败；同一连接不能重复初始化。

### 方法

| 方法 | 作用 |
| --- | --- |
| `initialize` | 协商协议版本和能力 |
| `thread/open` | 使用客户端 ID 或生成 ID，幂等打开持久 thread |
| `thread/read` | 读取权威历史和 thread 状态 |
| `thread/list` | 分页列出 thread 摘要 |
| `thread/reset` | 按同 thread 操作顺序追加 reset marker |
| `turn/start` | 创建 turn，立即返回 `turnId` 和排队状态 |
| `turn/cancel` | 取消指定 thread 当前正在执行的 turn |
| `approval/respond` | 回答 `approval/requested`（可选 capability，见下文） |
| `<namespace>/<name>` | 插件注册的方法，例如 `mcp/tools/call`，列在 `initialize` 结果的 `capabilities.methods` 中 |

`turn/start` 不能等待模型完成后才响应，否则客户端无法可靠建立 turn 状态。响应示例：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "turn": {
      "id": "turn_abc",
      "status": "queued"
    }
  }
}
```

当它真正获得同 thread 执行权时发送 `turn/started`，运行期间发送 message/tool notification，最后恰好发送一次 `turn/completed`。

### Notification

Runtime event 直接映射为同名 JSON-RPC notification：

```json
{
  "jsonrpc": "2.0",
  "method": "message/delta",
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_abc",
    "messageId": "msg_xyz",
    "delta": "你"
  }
}
```

v1 的事件只发送给发起该 turn 的连接。断线后不重放 delta，客户端通过 `thread/read` 获取最终权威状态。

`tool/completed` 在工具成功且返回了 details 时带上 `details`，内容与 `thread/read` 里对应 toolResult 的 `details` 相同。details 的形状属于注册该工具的插件，例如 MCP 插件返回完整的 MCP `CallToolResult`（含 `structuredContent` 和 `_meta`）。客户端可以据此实时渲染，不必等 turn 结束后再读 thread。

### 工具审批

blueprint 的 `approval`（`writes` 或精确的工具名列表）决定哪些工具调用要先得到用户同意。这是 v1 内新增的可选 capability：

- 客户端在 `initialize` 的 `params.capabilities.approvals: true` 中声明自己会回答审批。服务端在结果的 `capabilities` 中返回 `approvals: true`。
- 声明了的连接，在它发起的 turn 需要审批时收到 notification，同样排在 `turn/start` 的响应之后：

```json
{
  "jsonrpc": "2.0",
  "method": "approval/requested",
  "params": {
    "type": "approval/requested",
    "threadId": "thr_123",
    "turnId": "turn_abc",
    "approvalId": "apr_…",
    "tool": "notion__notion_create_pages",
    "description": "…",
    "input": { "pages": [] }
  }
}
```

- 客户端用 `approval/respond { approvalId, approved }` 回答。未在等待的 `approvalId` 返回错误码 `-32012`。
- turn 被取消、超时或连接关闭时，等待中的审批按拒绝处理，客户端从 `turn/completed` 得知结束。
- 没有声明的客户端（包括旧客户端）不会收到审批请求：需要审批的调用直接被拒绝并告知模型，turn 不会卡住。
- 审批只在内存中等待。durable runtime 重启后恢复的 turn 没有人可问，同样拒绝。

### 插件方法

插件可以用 `zing.registerMethod({ name, handle })` 向 App Server 客户端提供方法。核心只负责路由，不理解方法的含义：

- 名字必须是 `<namespace>/<name>`，只用小写字母、数字、`_` 和 `-`，例如 `mcp/resources/read`。`approval`、`message`、`thread`、`tool`、`turn`、`zing` 这几个 namespace 保留给 App Server 自己。
- 有插件方法时，`initialize` 结果的 `capabilities.methods` 列出它们的名字；没有时不出现这个字段。
- params 原样交给插件，插件的返回值原样作为 result。插件抛错时返回错误码 `-32020`，message 是插件给出的说明。
- 方法收到的 `signal` 在连接关闭时中止。
- 只有 App Server 客户端能调用插件方法，Channel 不经过这里。

MCP 插件用它支持 [MCP Apps](https://github.com/modelcontextprotocol/ext-apps)（交互式卡片），核心里没有任何 MCP 概念：

| 方法 | 作用 |
| --- | --- |
| `mcp/servers/list` | 每个 server 的 capabilities 和工具定义（含 `_meta.ui.resourceUri`、`_meta.ui.visibility`）；模型可见的工具带上它在 Zing 里的名字 `zingTool` |
| `mcp/resources/read { server, uri }` | 读取 server 的资源，例如 app 的 `ui://` HTML |
| `mcp/tools/call { server, name, arguments }` | 替 app 调用它自己 server 上的工具；只允许 visibility 含 `app` 的工具 |

客户端看到 `tool/started` 的工具名对应一个带 `resourceUri` 的工具时，读取 HTML 放进沙箱 iframe，把 `tool/started.input` 和 `tool/completed.details` 交给 app。app 发起的工具调用是用户在客户端里的操作，不经过 blueprint 的审批；需要确认的客户端自己确认。参考实现见 [`examples/clients/web`](../examples/clients/web)。

### 版本策略

- `protocolVersion: 1` 表示 wire compatibility，不使用 npm package version 推断协议兼容性。
- 同一协议版本只能增加可选字段、方法、notification 或 capability。
- 客户端必须忽略未知字段和未知 notification。
- 删除字段、改变字段语义或改变已有枚举值需要新的协议版本。
- 发布稳定 v1 前提供 checked-in JSON Schema 和协议 fixtures，使其他语言不依赖 Zing 的 TypeScript 源码。

## 执行不变量

### 排队

1. 同一 `threadId` 的 turn 和 reset 共用一个 FIFO 队列。
2. 同一 thread 最多只有一个活动 Pi run。
3. 不同 thread 可以并行执行。
4. 一个失败或取消的 turn 不能阻塞队列后续操作。
5. reset 默认排在已接收操作之后；需要立即停止当前 turn 的客户端应先调用 `turn/cancel`，再调用 `thread/reset`。

### 取消

- `turn/cancel` 只接受当前活动 turn 的 `threadId + turnId`。
- 它调用对应 `PiAgent.abort()`，而不是删除整个 Conversation。
- 已产生的 user/assistant/tool 消息仍在 turn 结束路径中持久化。
- terminal event 的状态为 `canceled`，且只发送一次。
- v1 的 `turn/cancel` 不取消尚未开始的排队 turn；请求取消非活动 turn 返回明确错误。transport 整体关闭时会取消该 session 持有的所有 handle，包括排队 turn。

### 持久化

- Capsule transcript 是历史事实来源，实时事件流不是数据库。
- transcript 必须始终是内存 Agent messages 的已提交前缀，不能重复 append。
- 成功、失败和取消都经过同一 finally 持久化路径。
- 只有持久化成功后才能发成功的 terminal event；持久化失败必须使 turn 为 `failed`。
- reset 与 turn append 使用同一 per-thread 队列，修复当前竞态。
- JSONL 解析只可以容忍“文件不以换行结尾且最后一行不是完整 JSON”这一种崩溃残留；其他坏行仍应报错，避免静默丢历史。

### 上下文和运行预算

- Capsule 保留完整 transcript；`transformContext` 只裁剪发给模型的请求视图，不改写持久历史。
- 裁剪只从最旧的完整 user turn 开始，assistant tool call 和对应 tool result 不会被拆开。
- 固定的 omission marker 明确告诉模型存在更早历史；近期 turn 连同 system、tools、输出预留和安全余量必须适配模型声明的 context window。
- 单条 user 输入如果不能适配上下文预算，在调用模型前失败。
- 每个 turn 默认限制为 5 分钟、16 个模型轮次和 32 次工具调用；blueprint 的 `limits` 可以收紧或放宽。
- 预算触发产生 `failed` terminal event；已经产生的消息和工具结果仍按正常 finally 路径持久化。

### 断线

- Runtime 的 turn 生命周期独立于观察者生命周期。
- WebSocket 客户端断线不自动取消 turn；服务端继续运行并持久化。
- 重连客户端通过 `thread/read` 对账；v1 不提供 event replay、offset 或 resume token。
- stdio 收到 EOF 后停止接收新请求，取消该 session 已接受的活动和排队 turn，等待取消结果持久化后退出；强制杀进程不保证当前 turn 完成。

### 多客户端

- 多个客户端可以向同一 thread 提交 turn，它们仍进入同一个 FIFO 队列。
- 每个 turn 的实时事件只回到发起连接。
- v1 不提供 thread 订阅或多客户端事件广播。

## 与现有 Channel 的兼容

现有插件 API 在 v1 保持兼容：

```ts
handleMessage(message)
  -> runtime.startTurn(message)
  -> await handle.completed
  -> AgentResult

resetConversation(conversationId)
  -> runtime.resetThread(conversationId)
```

Telegram 和 stdio Channel 不需要立即改造。它们以后可以选择订阅 Runtime 事件，但这不是 App Server v1 的前置条件。

App Server 是新的顶层运行模式，不伪装成 Channel：

```text
zing --once "hello"       # 当前一次性 Channel 模式
zing --channel telegram   # 当前进程内 Channel 模式
zing app-server           # 新增 JSON-RPC stdio 模式
```

公共 bootstrap 应拆出“加载 config/plugins、创建 station/capsule/runtime”的共享部分；Channel mode 和 App Server mode 在 runtime 创建之后分流。这样不会把协议生命周期塞进 `registerChannel`。

## 实现顺序（已完成）

### 1. 先修复既有一致性问题

- 将 reset 放进 per-thread 队列。
- 对截断的最后一行 JSONL 做严格限定的恢复。
- 增加 turn/reset 重叠和截断日志测试。

这一步不改变公共 API。

### 2. 引入 Runtime 事件与 TurnHandle

- 新增与 Pi 无关的 runtime 类型。
- 在 `Conversation.prompt` 周围生成 `turnId`，映射 Pi message/tool 事件。
- 记录活动 `turnId -> Conversation`，连接 `cancel` 与 `PiAgent.abort()`。
- 保留 `ConversationHost`，改为 Runtime 上的兼容 shim。
- 验证现有 Channel、observer 通知和持久化行为不变。

### 3. 扩展 Capsule thread 查询

- 增加 ensure/read/list API。
- 将 transcript 转换为公共 `ThreadSnapshot`。
- 保持当前目录布局和现有 JSONL 文件可直接加载。
- 为 `thread/list` 返回稳定 envelope：`{ data, nextCursor }`，即使首版数据量很小也不直接返回裸数组。

### 4. 实现 transport-neutral dispatcher

- JSON-RPC envelope 解析和基础校验。
- initialize 状态机。
- method -> Runtime 路由。
- Runtime event -> notification 路由。
- 标准 JSON-RPC 错误与少量稳定的 Zing 错误码。
- dispatcher 测试不启动 stdio 或真实模型。

### 5. 增加 stdio App Server

- JSONL reader/writer。
- 并发处理请求，使 `turn/cancel` 不会被活动 `turn/start` 阻塞。
- stdout 协议纯净性和 stderr 日志测试。
- CLI 增加 `app-server` 模式，共用现有 bootstrap。
- 加入最小客户端 fixture，覆盖 initialize、open、start、delta、complete、read。

### 6. 发布协议 artifact

- 固定 v1 TypeScript 类型。
- 生成并提交 JSON Schema。
- 提供最小 Node 客户端示例，但不提供 UI。
- 文档说明未知事件处理、取消和断线恢复。

### 7. 后续 transport

- WebSocket binding 复用 dispatcher，不修改 Runtime。
- 默认只监听 loopback；监听非 loopback 时必须配置 bearer token 和 TLS 终止层。
- AG-UI、ACP、HTTP/SSE 只能作为独立 adapter，不进入 core package。

## 验证计划

至少覆盖：

- 同 thread 的两个 turn 保持 FIFO，并获得不同 turnId。
- 不同 thread 可以并发。
- turn 失败和取消后，后续 turn 仍可执行。
- cancel 只作用于匹配的活动 turn。
- reset 与活动/排队 turn 的顺序确定，重启后结果一致。
- 每个 turn 恰好一个 terminal event，且发生在持久化之后。
- 文本 delta 顺序正确，拼接结果与 `message/completed` 一致。
- 工具 started/completed 使用同一 callId。
- 旧 transcript、reset transcript、截断最后一行都按约定加载。
- 连接断开不改变 runtime turn 结果，`thread/read` 可以恢复最终状态。
- initialize 前调用、重复 initialize、未知方法、非法 params 返回稳定错误。
- stdio stdout 中没有日志或非 JSON 内容。
- 现有 agent、capsule、transcript、Telegram 和 plugin 测试继续通过。

## v1 明确不做

- UI 组件、布局、主题或 generative UI 描述。
- AG-UI、ACP 等协议兼容层。MCP Apps 不进核心：MCP 插件通过插件方法提供 `ui://` 资源和 app 的工具调用，渲染由客户端负责。
- event replay、offset、resume token 和 exactly-once delivery。
- thread 实时订阅和多客户端广播。
- turn steering、排队 turn 取消和 turn 重试。
- 用户表单和 server-to-client request。工具审批已作为可选 capability 加入（notification + method，见上文）。
- thread fork、archive、pin、title、tag、全文搜索。
- 图片和附件作为协议输入；现有 transcript 的图片存储能力保持不变。
- 多 agent / 多 capsule 的单进程托管。
- WebSocket、远程账号系统和复杂鉴权。
- 将当前 transcript 文件格式直接承诺为公共 wire format。

## v1 完成标准

当以下条件同时成立时，App Server v1 才算完成：

1. 一个独立 Node 客户端可以启动 `zing app-server`，完成握手并创建或打开 thread。
2. 客户端能开始 turn，立即获得 turnId，并持续收到文本和工具事件。
3. 客户端能取消活动 turn，并收到唯一 terminal event。
4. 客户端退出并重新连接后，能通过 `thread/read` 取得已持久化历史。
5. Telegram 和 `--once` 不经过 JSON-RPC 仍保持现有行为。
6. 公共协议中不存在 Pi、AG-UI、ACP 或任何 UI framework 类型。
7. JSON Schema、协议 fixtures、实现和文档对 v1 消息保持一致。
