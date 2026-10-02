# Turn、Step 与 V4 工具流水线

> 固定版本：`dsh-v0.1.7-rc.2`；revision：`477b4f420553e8a52c2fbccc464d7561b239c443`；源码审查：2026-09-29。

一轮可以没有 step，也可以因工具和 steering 包含多步；一个 step 可以因显式 retry 包含多次 provider attempt。日志坐标和业务重试不是同一种身份。

## Verified from source

| 入口 | 职责 |
| --- | --- |
| [driver](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/agent.ts) | pre-step、prepared call、attempt settlement 与继续条件 |
| [tool scheduler](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/tool-calls.ts) | dispatch overlap、模型顺序提交、call/result 配对 |
| [ToolRuntime](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/tools/src/index.ts) | policy、guard、执行、后处理与冻结结果 |
| [Session event types](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/types.ts)、[message](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm/src/message.ts) | V4 event data 与 first-class tool message |
| [repair](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/repair.ts) | 中断历史中的缺失工具结果 |

### 从输入到模型请求

`followup()` → durable inbox → turn/start → claim → prompt/context assembly → `agent/pre-step`。只有进入的非空首批输入才建立 step。`agent/request` 和 `prepareCall()` 先解析实际 route；在这些 async 阶段赢得取消时，不提交 system/users。随后按 prepared capability 协调 `system/message`，第一次 attempt 才追加 accepted user messages，记录 header/context 并派生冻结的模型历史。retry 复用本步 assembly，不重复 claim/pre-step。

实时输出走 process-local `agent/assistant-stream` 的 start/chunk/end；每个完成结算的 attempt 提交一条 `assistant/message` 或 log-only `assistant/attempt`，其中 `stream` 保存紧凑的带时序记录。它们不是旧顶层 `assistant/chunk` 事件。取消时已输出的 text/reasoning 前缀可以作为 `interrupted: true` 的 assistant message 提交；未 dispatch 的工具调用不混入该前缀。进程在 settlement 前硬退出时不能假定已有 durable stream。

```mermaid
flowchart TD
    A["turn/start + input claim"] --> B["pre-step admits step"]
    B --> C["agent/request + prepareCall"]
    C --> D["system / user / header / context committed"]
    D --> E["derive frozen model request"]
    E --> F["live assistant stream"]
    F --> G["assistant/message or assistant/attempt"]
    G --> H["tool/call + tool execution"]
    H --> I["tool/result in model order"]
    I --> J["step/end"]
    J -->|"tools or steering owe work"| B
    J -->|"no work owed"| K["turn-stopping + turn/end"]
```

### 工具结果的准确字段

`tool/call.data` 为 `{ turn, step, callId, name, arguments }`，arguments 保留模型给出的 JSON 字符串。V4 `tool/result.data` 为 `{ turn, step, message, error?, meta? }`；`message` 是直接的 tool-role message，包含 `toolCallId`、`content`、`isError` 和 identity/source。关联读取应使用 **`data.message.toolCallId`**，不能照搬旧 `data.result` 或假设 result 顶层仍有 callId。内部 failure identity 放在可选 `data.error`，只有 isError 为 true 才允许；UI 数据放在 tool-owned JSON meta。

scheduler 先提交 tool/call，再进入 `pre-execute → guards → execute → post-execute → finalizeContent → tools/result`。最后一个是 live 观察事件，不是 durable event。scheduler 将最终内容写入 `tool/result`，其 `sourceEventSeqs` 引用对应 call 的 seq，模型下次请求直接读 first-class tool message。

`exclusive` 是 barrier，`parallel` 使用配置的 rolling pool。准备和提交保持模型调用顺序，body 可以重叠；后来者先完成不改变 durable result 顺序。工具结果通常使同一 turn 进入下一步；`concludesTurn` 仍需尊重已经到达的 next-step 输入。

### 错误与不确定结果

工具 pipeline 可把失败表达为 isError 结果，让模型在下一步处理。scheduler 自身终止失败不伪造已经开始的 call 的结果；中断恢复根据历史生成 `TOOL_NOT_STARTED` 或 `TOOL_OUTCOME_UNKNOWN` 等结果。看到 durable call 但没有 durable result，无法推出外部工具没有执行。

provider error 只有在 `agent/request-error` 明确返回 retry 时才重试该 step；这不授权业务层重放整条 prompt。run resolve、非空文本、Agent idle 都不单独代表 `turn/end.reason.kind === completed`。

## Observed at runtime

2026-09-29 从仓库根目录执行：

```sh
node --test --test-name-pattern='missing tool' how-dsh-works/probes/published-core.test.mjs
```

本次完整 probe 3/3 passed；该 case 由确定性 adapter 请求一个未注册工具，真实 ToolRuntime 生成 V4 error message，再由下一步模型请求读取；验证 toolCallId、call seq 引用和两个 step。另一个 inbox case 验证 live frames 与 embedded stream。没有真实工具副作用或 provider 网络请求。

## Inference、Proposal 与未确认

Inference：持久化 call/result 分开意味着重试前必须查询外部状态。Proposal：增加受控双 parallel 工具验证 out-of-order settlement。本次没有重新执行 parallel scheduler、真实取消、repair 或 retry probes；[旧两项测试](historical-2026-08-31.md)不能算新版证据。
