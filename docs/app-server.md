# Zing App Server v1 Implementation Design

> Status: v1 is implemented. This document records the pre-implementation baseline, final architecture, protocol, and boundaries for future evolution.

## Goals

Zing owns the agent's identity, conversations, memory, tools, and execution; clients own only the interaction experience. Anyone can build a web, desktop, CLI, Telegram, Slack, or other client without modifying Zing or adopting a UI framework prescribed by Zing.

v1 must provide:

- No UI dependencies and no transmission of components, layouts, or styles.
- The same runtime behavior for in-process Channels and out-of-process clients.
- Text deltas, tool status, and final turn status for clients.
- Well-defined semantics for conversation persistence, serial execution within a conversation, cancellation, and reset.
- No dependency on AG-UI, ACP, or other agent-to-UI protocols; adapters may be provided outside the core later.
- No direct exposure of types or events from `@earendil-works/pi-agent-core`.

## Pre-implementation Baseline

The call chain at the baseline was:

```text
Channel.start(signal)
    -> ConversationHost.handleMessage
        -> queue by conversationId in createAgent
            -> Conversation.prompt
                -> PiAgent.prompt
                -> Capsule appends the JSONL transcript
        <- Promise<AgentResult>
    <- Channel sends the final text
```

Key boundaries:

- `src/plugin/types.ts`: `ConversationHost` exposes only `handleMessage` and `resetConversation`.
- `src/agent.ts`: caches `Conversation` by `conversationId`, serializes execution within each conversation through `pending`, and maps Pi message/tool events to runtime events.
- `src/capsule.ts`: stores agent identity and handles loading, appending to, and resetting conversations.
- `src/transcript.ts`: stores conversations as JSONL, with paths mapped from `channel:localId`.
- `src/index.ts`: selects and starts one Channel per process.
- `plugins/channels/telegram/index.ts`: the Channel calls the in-process `ConversationHost` directly and replies after receiving the complete result.

Existing capabilities:

- Agent identity and conversation history survive process restarts.
- Conversations are isolated from one another.
- Messages in the same conversation execute in arrival order.
- A single failure does not block subsequent messages.
- Channels, providers, tools, and conversation observers are all supplied by plugins.

Gaps for v1 to address:

- No stable streaming runtime API.
- Clients cannot observe text deltas, generic tool lifecycles, or turn status.
- No interfaces for cancellation, thread read/list, or state reconciliation after disconnection.
- Conversation IDs serve both as domain IDs and as storage path conventions.
- `resetConversation` does not enter the conversation's execution queue. If it overlaps an active turn, that turn may append messages after the reset marker.
- A crash while writing the last JSONL line may leave a truncated line; baseline parsing then prevents the entire conversation from loading.

## Review Decision

Do not adopt a design in which the protocol is the core. Define a transport-independent Zing Runtime first, with JSON-RPC as a thin adapter around it.

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

Reasons for this boundary:

1. `ConversationHost` already provides the beginnings of an in-process domain interface and can be extended incrementally.
2. Channels and tests should not need serialization to make calls within the same process.
3. Runtime events also isolate Pi, allowing the underlying agent core to be replaced without affecting clients.
4. JSON-RPC, stdio, WebSocket, AG-UI, and ACP are transports or compatibility layers that can be replaced independently.

v1 introduces **Thread** and **Turn**, but does not copy Codex's generic Item system:

- Thread: a persistent conversation, corresponding to the existing conversation concept.
- Turn: one user input and all agent work it triggers. Cancellation, queuing, and event correlation rely on a stable `turnId`.
- Message and Tool: the two concrete event categories in v1. Add new events when new units of work are needed, rather than designing a generic Item union in advance.

## Runtime Domain Interface

The following is the target shape; these exact type names are not required:

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

Implementation constraints:

- `TurnHandle` is a hot execution handle: whether anyone subscribes to events must not determine whether the turn runs.
- Event listeners must not block the agent loop; transport writes must be decoupled from Pi's synchronous event callbacks.
- Emit `turn/completed` only after the transcript produced by that turn has been persisted.
- Final content in `message/completed` and `turn/completed` is authoritative; deltas serve only the live interaction experience.
- `AgentResult = { text: string }`; existing Channels need not consume any streaming events.

### Pi Event Mapping

The Runtime is an anti-corruption layer around Pi. The following mappings occur only within `src/agent.ts`:

| Pi event | Runtime event |
| --- | --- |
| The outer `PiAgent.prompt` actually begins execution | `turn/started` |
| `text_delta` within `message_update` | `message/delta` |
| assistant `message_end` | `message/completed` |
| `tool_execution_start` | `tool/started` |
| `tool_execution_end` | `tool/completed` |
| The prompt succeeds, fails, or aborts, and persistence finishes | `turn/completed` |

Pi's `turn_start` / `turn_end` describe one model round. A Zing Turn may contain multiple model rounds because of tool calls, so these events cannot map directly to a Zing Turn.
Pi's `tool_execution_update` is excluded from v1 to avoid turning unstable underlying partial-result structures into a public protocol commitment.

## Threads and History

### Thread ID

- The Runtime treats `threadId` as an opaque string and does not interpret any channel meaning within it.
- If `thread/open` receives no ID, the server generates one, such as `thr_<uuid>`.
- Messaging systems may supply stable, namespaced IDs such as `telegram:12345`, avoiding an extra mapping table.
- Client-supplied IDs are limited to 80 UTF-8 bytes, cannot contain control characters, and are safely encoded as paths by the Capsule.
- The existing `channel:localId` file layout remains compatible; it becomes a Capsule storage detail rather than a public domain rule.

### History Model

`thread/read` returns a public `ThreadSnapshot` containing user, assistant, and tool-result history since the last reset. Its semantics correspond to the existing `TranscriptEvent`, but public protocol types must not directly alias storage types:

- The transcript's `v`, paths, and reset markers are storage details.
- Public history DTOs represent only messages, tool results, timestamps, and necessary model information.
- A storage format upgrade must not force a breaking protocol change.
- A protocol field upgrade must not require rewriting existing transcripts.

The Capsule now provides ensure/read/list capabilities. Pi restoration still uses the existing `loadConversation`, while client reads go through public DTO conversion.

## Zing Protocol v1

### Envelope and Transport

- Use standard JSON-RPC 2.0, retaining the `"jsonrpc": "2.0"` field.
- The initial transport is stdio, with one complete JSON object per line (JSONL).
- stdout must contain only protocol messages; logs and diagnostics must go to stderr.
- A future WebSocket transport will reuse the same dispatcher, with one JSON-RPC message per text frame.
- v1 does not depend on a JSON-RPC framework; the dispatcher needs only request validation, method routing, responses, and notifications.

### Initialization

Each connection must call `initialize` first:

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

The response returns the negotiated version, agent identity, and capabilities. Other methods must fail before initialization, and a connection cannot initialize twice.

### Methods

| Method | Purpose |
| --- | --- |
| `initialize` | Negotiate the protocol version and capabilities |
| `thread/open` | Idempotently open a persistent thread using a client-supplied or generated ID |
| `thread/read` | Read authoritative history and thread state |
| `thread/list` | List paginated thread summaries |
| `thread/reset` | Append a reset marker in the thread's operation order |
| `turn/start` | Create a turn and immediately return its `turnId` and queued status |
| `turn/cancel` | Cancel the currently executing turn in the specified thread |

`turn/start` must not wait for the model to finish before responding; otherwise clients cannot reliably establish turn state. Example response:

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

Emit `turn/started` when the turn actually gains execution within its thread, message/tool notifications while it runs, and exactly one `turn/completed` at the end.

### Notifications

Runtime events map directly to JSON-RPC notifications with the same names:

```json
{
  "jsonrpc": "2.0",
  "method": "message/delta",
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_abc",
    "messageId": "msg_xyz",
    "delta": "Hello"
  }
}
```

v1 events are sent only to the connection that started the turn. Deltas are not replayed after disconnection; clients use `thread/read` to retrieve the final authoritative state.

### Versioning Policy

- `protocolVersion: 1` denotes wire compatibility; do not infer protocol compatibility from the npm package version.
- Within one protocol version, changes may only add optional fields, methods, notifications, or capabilities.
- Clients must ignore unknown fields and unknown notifications.
- Removing fields, changing field semantics, or changing existing enum values requires a new protocol version.
- Provide a checked-in JSON Schema and protocol fixtures before releasing stable v1 so other languages do not depend on Zing's TypeScript source.

## Execution Invariants

### Queuing

1. Turns and resets for the same `threadId` share one FIFO queue.
2. Each thread has at most one active Pi run.
3. Different threads may execute concurrently.
4. A failed or canceled turn must not block subsequent queued operations.
5. By default, reset follows already accepted operations. Clients that need to stop the current turn immediately should call `turn/cancel` before `thread/reset`.

### Cancellation

- `turn/cancel` accepts only the `threadId + turnId` of the currently active turn.
- It calls the corresponding `PiAgent.abort()` rather than deleting the entire Conversation.
- User, assistant, and tool messages already produced are still persisted through the turn's completion path.
- The terminal event has status `canceled` and is emitted only once.
- v1's `turn/cancel` does not cancel queued turns that have not started; canceling an inactive turn returns an explicit error. Closing the entire transport cancels all handles owned by that session, including queued turns.

### Persistence

- The Capsule transcript is the source of historical truth; the live event stream is not a database.
- The transcript must always be a committed prefix of the in-memory Agent messages, without duplicate appends.
- Success, failure, and cancellation all use the same `finally` persistence path.
- A successful terminal event may be emitted only after persistence succeeds; a persistence failure must mark the turn as `failed`.
- Reset and turn append use the same per-thread queue, fixing the baseline race condition.
- JSONL parsing may tolerate only one kind of crash residue: a file without a trailing newline whose final line is incomplete JSON. Other malformed lines must still raise errors to avoid silently losing history.

### Context and Execution Budgets

- The Capsule retains the full transcript; `transformContext` trims only the request view sent to the model, without rewriting persistent history.
- Trimming starts with the oldest complete user turns; assistant tool calls and their corresponding tool results are never split apart.
- A fixed omission marker explicitly tells the model that earlier history exists. Recent turns, together with the system prompt, tools, output reserve, and safety margin, must fit within the model's declared context window.
- A single user input that cannot fit within the context budget fails before the model is called.
- Each turn defaults to limits of 5 minutes, 16 model rounds, and 32 tool calls; the blueprint's `limits` may tighten or relax them.
- Exceeding a budget produces a `failed` terminal event; messages and tool results already produced are still persisted through the normal `finally` path.

### Disconnection

- The Runtime's turn lifecycle is independent of the observer lifecycle.
- A WebSocket client disconnect does not automatically cancel a turn; the server continues execution and persistence.
- Reconnecting clients reconcile state through `thread/read`; v1 provides no event replay, offsets, or resume tokens.
- On EOF, stdio stops accepting new requests, cancels active and queued turns accepted by that session, and waits for cancellation results to be persisted before exiting. Force-killing the process does not guarantee completion of the current turn.

### Multiple Clients

- Multiple clients may submit turns to the same thread; those turns still enter the same FIFO queue.
- Live events for each turn return only to the originating connection.
- v1 provides neither thread subscriptions nor multi-client event broadcasting.

## Compatibility with Existing Channels

The existing plugin API remains compatible in v1:

```ts
handleMessage(message)
  -> runtime.startTurn(message)
  -> await handle.completed
  -> AgentResult

resetConversation(conversationId)
  -> runtime.resetThread(conversationId)
```

Telegram and stdio Channels do not require immediate changes. They may choose to subscribe to Runtime events later, but that is not a prerequisite for App Server v1.

App Server is a new top-level operating mode, not a disguised Channel:

```text
zing --once "hello"       # Existing one-shot Channel mode
zing --channel telegram   # Existing in-process Channel mode
zing app-server           # New JSON-RPC stdio mode
```

The shared bootstrap should extract configuration/plugin loading and station/capsule/runtime creation. Channel mode and App Server mode diverge after runtime creation, keeping protocol lifecycle management out of `registerChannel`.

## Implementation Sequence (Completed)

### 1. Fix Existing Consistency Issues First

- Put reset into the per-thread queue.
- Add narrowly scoped recovery for a truncated final JSONL line.
- Add tests for overlapping turns/resets and truncated logs.

This step does not change the public API.

### 2. Introduce Runtime Events and TurnHandle

- Add runtime types independent of Pi.
- Generate `turnId` around `Conversation.prompt` and map Pi message/tool events.
- Track active `turnId -> Conversation` mappings and connect `cancel` to `PiAgent.abort()`.
- Retain `ConversationHost` as a compatibility shim over the Runtime.
- Verify that existing Channel behavior, observer notifications, and persistence remain unchanged.

### 3. Extend Capsule Thread Queries

- Add ensure/read/list APIs.
- Convert transcripts to public `ThreadSnapshot` objects.
- Preserve the current directory layout and direct loading of existing JSONL files.
- Return a stable `{ data, nextCursor }` envelope from `thread/list`, not a bare array, even if the initial dataset is small.

### 4. Implement a Transport-neutral Dispatcher

- Parse and validate JSON-RPC envelopes.
- Implement the initialization state machine.
- Route methods to the Runtime.
- Route Runtime events to notifications.
- Use standard JSON-RPC errors and a small set of stable Zing error codes.
- Test the dispatcher without starting stdio or a real model.

### 5. Add the stdio App Server

- Implement a JSONL reader/writer.
- Handle requests concurrently so an active `turn/start` does not block `turn/cancel`.
- Test that stdout contains only protocol messages and logs go to stderr.
- Add the CLI's `app-server` mode using the existing bootstrap.
- Add a minimal client fixture covering initialize, open, start, delta, complete, and read.

### 6. Publish Protocol Artifacts

- Finalize the v1 TypeScript types.
- Generate and commit the JSON Schema.
- Provide a minimal Node client example, but no UI.
- Document handling of unknown events, cancellation, and recovery after disconnection.

### 7. Future Transports

- Reuse the dispatcher for a WebSocket binding without changing the Runtime.
- Listen only on loopback by default; non-loopback listeners must have a bearer token and a TLS termination layer.
- Keep AG-UI, ACP, and HTTP/SSE in independent adapters, outside the core package.

## Validation Plan

Cover at least:

- Two turns in the same thread preserve FIFO order and receive distinct turn IDs.
- Different threads can run concurrently.
- Subsequent turns still execute after a turn fails or is canceled.
- Cancellation affects only the matching active turn.
- Reset ordering relative to active/queued turns is deterministic and remains consistent after restart.
- Each turn emits exactly one terminal event, after persistence.
- Text deltas arrive in the correct order and concatenate to the content of `message/completed`.
- Tool started/completed events use the same `callId`.
- Legacy transcripts, reset transcripts, and truncated final lines load according to the contract.
- Disconnection does not alter runtime turn results, and `thread/read` can retrieve the final state.
- Calls before initialization, repeated initialization, unknown methods, and invalid parameters return stable errors.
- stdio stdout contains no logs or non-JSON content.
- Existing agent, capsule, transcript, Telegram, and plugin tests continue to pass.

## Explicit v1 Non-goals

- UI components, layouts, themes, or generative UI descriptions.
- Compatibility layers for AG-UI, ACP, MCP UI, or similar protocols.
- Event replay, offsets, resume tokens, or exactly-once delivery.
- Live thread subscriptions or multi-client broadcasting.
- Turn steering, queued-turn cancellation, or turn retries.
- Tool approvals, user forms, or server-to-client requests; JSON-RPC leaves room to add them later.
- Thread forks, archives, pins, titles, tags, or full-text search.
- Images and attachments as protocol inputs; existing transcript support for storing images remains unchanged.
- Hosting multiple agents or Capsules in one process.
- WebSocket, remote account systems, or complex authentication.
- Committing to the current transcript file format as the public wire format.

## v1 Completion Criteria

App Server v1 is complete only when all of the following hold:

1. An independent Node client can start `zing app-server`, complete the handshake, and create or open a thread.
2. The client can start a turn, receive its turn ID immediately, and continuously receive text and tool events.
3. The client can cancel an active turn and receive exactly one terminal event.
4. After exiting and reconnecting, the client can retrieve persisted history through `thread/read`.
5. Telegram and `--once` retain their existing behavior without going through JSON-RPC.
6. The public protocol contains no Pi, AG-UI, ACP, or UI framework types.
7. The JSON Schema, protocol fixtures, implementation, and documentation agree on v1 messages.
