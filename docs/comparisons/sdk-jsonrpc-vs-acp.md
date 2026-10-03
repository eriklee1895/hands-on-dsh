# SDK JSON-RPC 与 ACP：如何选择

为界面加一个“停止”按钮时，先看客户端能向 runtime 发出什么控制。如果入口只有提交和 shutdown，浏览器按钮本身无法补出单任务取消。这是选择 SDK JSON-RPC 或 ACP 之前应先解决的问题。

本文固定 DSH `0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`。协议实验使用同版本 npm dsh；ACP 实现依赖 `@agentclientprotocol/sdk@1.4.0`，仍协商 protocol v1。下文是这个版本的 DSH 实现，不把 ACP 标准或其他 Agent 的能力等同于它。

需要 DSH 原生 SessionEvent、工具与 subagent 观察时，选择 SDK JSON-RPC；需要标准取消、权限交互、持久会话 list/resume/close 或模型配置时，选择 ACP。业务 Run、幂等、审批期限和 Artifact 所有权仍由应用管理。

## 方法与方向

| 能力 | SDK JSON-RPC | DSH ACP v1 |
| --- | --- | --- |
| 初始化 | `initialize`，传 cwd/provider/model，可选 reasoningEffort/maxTokens | `initialize`，协商版本、客户端能力并返回实际支持的 capabilities |
| 认证 | 无独立方法 | `authenticate` 为 no-op，`authMethods: []`；不是应用身份认证 |
| 新会话 | `session/prompt` 对未知 ID lazy create | `session/new`，验证绝对 cwd 与 MCP 配置后创建持久 root session |
| 提交输入 | `session/prompt` 立即返回 durable inbox `messageId` | `session/prompt` 为在途请求，结束后返回 `stopReason` |
| 列举 | 无 | `session/list`：持久、inactive、可恢复 root；可按 cwd 过滤和分页 |
| 恢复 | 无公开 resume RPC | `session/resume`：恢复 inactive session，校验同一物理 workspace，不回放旧 update |
| 关闭一个会话 | 无 | `session/close`：停止该 Agent 的活动、排空更新、回收后代并 flush/dispose |
| 模型配置 | initialize 时选择 route | `session/set_config_option`，使用已公布的 model/reasoning_effort 选项；下一次 prompt 使用新选择 |
| 取消 | 无 cancel RPC；关闭 client 会终止整个 runtime | `session/cancel` notification 或 `$/cancel_request`；不等同于撤销已有副作用 |
| 权限 | 无 server→client permission 控制接口 | agent→client `session/request_permission`，一次性允许或拒绝 |
| 关闭进程 | `shutdown` request 后 stdin EOF，必要时信号回收 | 先关闭所持会话，再结束连接；没有 SDK 式 `shutdown` 方法 |

ACP 的 resume 与 `session/load` 不是同一能力。当前 DSH 没有实现 load/history replay、删除或 fork；恢复后模型读取持久历史，不代表客户端会重获旧消息的 UI transcript。配置选项是 opaque 的 advertised values，不能根据模型名自行拼 value。

## 事件与结果

| 观察项 | SDK JSON-RPC | DSH ACP v1 |
| --- | --- | --- |
| 下行 | `session.event`、`session.status`、`subagent.started/finished` | `session/update`；permission 为反向 request |
| 文本 | root `assistant/message` 中的已提交文本 | committed `agent_message_chunk`；名称含 chunk 不等于逐 token |
| 实时 provider delta | 当前 server 不转发进程内 `agent/assistant-stream` | 当前 bridge 不投影 raw provider delta |
| 持久 stream | message/attempt 内嵌紧凑 stream，随 SessionEvent 可见 | 不提供同等原始日志 |
| 接收回执 | matching `agent/inbox/spliced.inserted[].id` | prompt request 保持在途，无对应 SDK receipt |
| 完成 | receipt 之后下一次 root idle；仍需检查该区间的 turn/end | ordered committed delivery 后 prompt result，例如 end_turn/cancelled |
| 其他观察 | 原生 tool/session/subagent 事件 | 通用工具生命周期、配置与 context usage；不是完整 DSH UI 数据 |

SDK idle 描述整个 Agent 的活动，不把并发输入各自对应到独立 Run。原始 probe 需要在发送 prompt 前订阅，正确处理 receipt 先于 response；文本和终态都只选对应 receipt 到首次 root idle 的区间。ACP 对同一 session 一次只接纳一个 prompt，其他 session 可以独立运行。

ACP 的 `end_turn` 在固定 DSH 版本中也可能来自 aborted/blocked，不能直接归一化为根 turn completed；`max_tokens` 是另一个有效终态。新的[适配层实验](../../labs/protocol-semantics/ADAPTERS.md)分别保留 SDK completed 与 ACP settled，并用精确任务输出独立验收。

## 持久恢复的适用范围

同一进程的 session 复用不等于跨进程恢复。ACP `session/list` 排除正在运行/已激活的会话、subagent 和无有效 cwd 的记录；`session/resume` 要求 inactive 且请求 cwd 与持久 header 的目录一致。恢复实验必须复用持久 home 和同一个 workspace，不能一边删除目录一边声称验证了 resume。

当前 [AG-UI 项目](../../projects/ag-ui-dsh-runtime/README.md)固定 npm `0.1.7-rc.2`，仍通过 SDK deployment adapter 显式恢复 Session。换成 ACP 后，下行事件和客户端责任也会改变；只有相应投影、持久状态与端到端路径完成验证，才能替换这个 adapter。

## 启动与版本证据

[`labs/protocol-semantics`](../../labs/protocol-semantics/README.md) 保留无模型的 fake 和显式 command 探针，固定发行版使用项目自己的 npm dependency：

```text
project package.json + pnpm-lock.yaml
  -> same-version @deepseek-ai/dsh CLI
  -> --profile sdk-minimal or --profile acp
  -> JSONL peer + isolated HOME/DSH_HOME/workspace
```

不再使用旧 `packages/examples/*-demo` 私有 bin。SDK `serverInfo.version` 与 ACP `agentInfo.version` 都为 `0.0.1`，不能据此认定产品版本；需要读取安装包的 metadata 并与锁定版本比较。显式 command 模式可用于其他兼容 server，但其结果不证明固定 DSH 发行包。

`sdk-minimal` 的执行策略具有 host 权限，临时目录不是 sandbox。ACP 权限与 sandbox 能力依赖实际 profile 和 patch；收到 permission request 也不证明所有工具均被隔离。使用 no-tool prompt 做协议恢复验收，将执行隔离留给单独实验。

## 错误与验证

JSON-RPC request timeout 只结束客户端本地等待，不取消服务端工作。EOF 会拒绝 pending waiter；最终 exit code、是否 TERM/KILL、进程组是否仍存在，要在 close 后分别记录。forced reap 不等于正常退出。

SDK 的部分 handler 参数直接 cast，同时对 route、token、图像 admission 等有显式检查；不要声称它提供统一的 invalid-params code。ACP 对 schema、cwd 和不支持的配置提供协议错误。未实现方法也不能通过客户端 wrapper 自动获得。

当前实验把 fake transcript、固定源码与真实运行分开记录。真实 prompt/list/resume 的结果见[第三批验收](../reviews/2026-09-29-web-protocol-migration.md)；cancel/permission 的 keyless 测试不冒充真实模型审批或中断验收。

## 固定源码

- [SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/server/src/server.ts)：请求分派、session 创建和通知。
- [ACP 接口](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/acp/acp/src/index.ts)：list/resume/close/config 与能力公布。
- [ACP Session](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/acp/acp/src/session.ts)：prompt、取消、持久恢复和关闭。
- [ACP 使用说明](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/acp/acp/README.md)：标准自动化表面和未实现能力。
- [Profile 启动规则](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#application-launch)。
