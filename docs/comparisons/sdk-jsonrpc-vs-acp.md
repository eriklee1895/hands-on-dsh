# SDK JSON-RPC 与 ACP：如何选择

这两个协议都能驱动 DSH，但服务的调用方不同。需要读取 DSH 原生 `SessionEvent`、工具轨迹和 subagent 活动时，优先 SDK JSON-RPC；需要与支持 ACP 的 Agent 客户端互操作，或需要 wire-level cancel 与一次性 permission decision 时，优先 ACP。两者都不是业务任务控制平面。

本文只描述 [`labs/protocol-semantics`](../../labs/protocol-semantics/README.md) 固定的 DSH `0.1.1-rc.2` source revision。ACP 的 committed text 是 **DSH 的 ACP 投影**；ACP 协议本身不保证每个实现都只投影相同事件。

## 方法与方向

| 能力 | SDK JSON-RPC | ACP v1 |
| --- | --- | --- |
| 初始化 | client → server `initialize`，传 `cwd`、provider、model、可选 maxTokens | client → agent `initialize`，协商 `protocolVersion: 1` 与 client capabilities |
| 认证 | 无独立方法 | client → agent `authenticate`；本 lab 只验证 `authMethods: []` 的 no-op |
| 新会话 | `session/prompt` 遇到未知 session ID 时由 DSH lazy create | client → agent `session/new`，返回 fresh `sessionId` |
| 提交输入 | client → server `session/prompt`，返回 durable inbox `messageId` | client → agent `session/prompt`，最终返回 `stopReason` |
| 关闭 | client → server `shutdown`，随后 stdin EOF；acceptance 要求成功 response、exit 0、无 escalation | ACP 没有 lab-owned session close；client 先 EOF，必要时对 owned group 发 SIGTERM/SIGKILL，并如实记录结果 |
| 取消 | 没有 cancel 方法 | client → agent `session/cancel` notification，不返回 response |
| 权限 | 当前 SDK wire 没有 permission request | agent → client `session/request_permission` request，client 返回 selected/cancelled outcome |

## 事件与输出

| 观察项 | SDK JSON-RPC | ACP v1 |
| --- | --- | --- |
| 通知 | `session.event`、`session.status`、`subagent.started`、`subagent.finished` | `session/update`；permission 是反向 request，不是 notification |
| 原始流式文本 | `assistant/chunk.data.chunk` 的 `text-delta` | 本 DSH bridge 不投影 raw delta |
| committed 文本 | root `assistant/message.data.message.content` 的最后一条完整消息 | `session/update.update.sessionUpdate=agent_message_chunk` |
| prompt 接收 | matching `agent/inbox/spliced` 中 `inserted[].id == messageId` | 没有对应 receipt；`session/prompt` 是在途请求 |
| 完成判据 | matching receipt 之后下一次 root `session.status=idle`；`turn/end` 不是 prompt result | committed delivery 后收到 prompt result `end_turn`，或 cancel 后收到 `cancelled` |
| subagent | 原生 started/finished 通知与 child session events 可见 | 当前投影不提供完整 subagent event stream |
| transcript | raw chunk 与 committed message 分开；只用 committed message 规范化 | 只从 committed `agent_message_chunk` 规范化 |

## 控制能力

SDK JSON-RPC 是“观察能力广、控制能力窄”：它暴露细粒度 session log 投影，但没有 negotiation、cancel、session close、permission、list、resume、fork 或 history。`session/prompt` 的 `{messageId}` 只证明 durable inbox 接收，不是回答，也不拥有一个 `turn/end`。

ACP 的控制面更适合通用 Agent client：fresh session、prompt、cancel 和 one-shot permission 都在 wire 上。cancel 是 notification；DSH 只有在请求已 admission，Agent 活动与 committed delivery 都 quiesce 后才以 `cancelled` settle，所以它不是“立即完成业务取消”的承诺。

两者都不提供 authoritative business Run、任务恢复控制、session browser、完整 UI 状态或产物所有权。生产应用仍应持有自己的 Task、Run、Approval 和 Artifact 状态，并把 DSH session ID 当作 runtime reference。

## 错误

| 场景 | SDK JSON-RPC | ACP v1 |
| --- | --- | --- |
| unknown method | 当前 server handler failure `-32603` | `-32601` |
| invalid params/schema | 当前 server 直接 cast；不要声称稳定 `-32602` | `-32602` |
| unexpected handler failure | `-32603` | `-32603` |
| malformed notification | lab client 记录 diagnostic 后丢弃；不等价于 upstream policy | lab client 记录 diagnostic 后丢弃 |
| request timeout | 只移除本地 waiter，不取消 server work | 同样只移除本地 waiter；cancel 必须显式发送 |
| stdout EOF | 立即拒绝 pending；close 后才有 final returncode/stderr tail | 相同 transport 语义 |
| permission unavailable | 不适用 | request error 映射 unavailable；unknown option、cancel、reject 均 fail closed |

## 打包与启动

| 入口 | SDK JSON-RPC | ACP v1 |
| --- | --- | --- |
| 本 lab fake | `python -m protocol_labs.sdk_jsonrpc --server fake` | `python -m protocol_labs.acp --server fake` |
| pinned source | absolute `tsx` + `packages/examples/jsonrpc-demo/src/bin.ts` + absolute config | absolute `tsx` + `packages/examples/acp-demo/src/bin.ts --config ...` |
| published experience | Python `deepseek-harness-sdk` 可搭配 bundled runtime；本 lab 不依赖它 | rc.2 ACP demo 不是一个 zero-config binary distribution |
| explicit command | JSON argv `DSH_SDK_SERVER_ARGV` 与可选 absolute cwd；generic provider/model/prompt | JSON argv `DSH_ACP_SERVER_ARGV` 与可选 absolute cwd；只跑 generic prompt |

source mode 在 CLI-owned 隔离 cwd 启动绝对入口，防止 upstream checkout 的 `.env` 补入变量。child environment 只继承明确列出的路径、locale、证书变量，加入父进程已持有的 DeepSeek credential，并把 `HOME`、`DSH_HOME`、workspace 与 session roots 设为临时目录；它不继承 proxy、cloud、cookie 或其他 service-specific environment。`--allow-version-mismatch` 只提供 `conforming:false` 的学习运行，不能通过 live acceptance。

安全语义不同：SDK minimal config 硬编码 `danger-full-access`，所以传入 `DSH_PERMISSION_MODE=workspace-write` 不会限制 SDK source process；lab 只发送 no-tool prompt 并使用 disposable workspace，但不能声称 host filesystem 被隔离。ACP source composition 使用 `workspace-write`。ACP ordinary EOF 可能需要 TERM/KILL 才能回收，forced reap 不是 clean exit。

## 适用场景

- 选 SDK JSON-RPC：DSH 专用后端需要完整 SessionEvent、tool、subagent 观察，且能自行实现 receipt-to-idle、进程监督和持久业务状态。
- 选 ACP：客户端需要在 DSH、Hermes、Codex 或其他 ACP agent 之间互操作，或必须发送 wire cancel、响应一次性 permission。
- 先选更高层 API：Python 应用若不需要教学或 wire 探测，先使用 `DeepSeekHarness`；缺少高层包装时再检查 `HarnessClient`，只有已存在的 server method 仍无法访问时才手写 JSON-RPC。
- 不选任一 wire 直接充当业务控制平面：恢复、幂等、审批时限、断线重放和 Artifact 生命周期由应用层拥有。
