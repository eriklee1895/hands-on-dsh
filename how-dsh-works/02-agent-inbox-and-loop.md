# Agent Inbox 与 AgentLoop：输入、作用域与 whole-agent idle

> 固定版本：`dsh-v0.1.7-rc.2`；revision：`477b4f420553e8a52c2fbccc464d7561b239c443`；源码审查：2026-09-29。

`Agent` 是 live handle，AgentLoop 是可替换 driver，Session 是持久事实。业务 Run 不由这些对象中的某一个自动代表。

## Verified from source

| 入口 | 职责 |
| --- | --- |
| [Agent types](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent/src/runtime-types.ts)、[registry](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent/src/index.ts) | live handle、factory、initiator 与 create/resume 所有权 |
| [dispatch](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent/src/dispatch.ts) | `agentEvents` 与 `assembleContextFor` 的 Agent/作用域对应 |
| [loop factory](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/index.ts)、[driver](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/agent.ts) | 创建、初始化、恢复、turn 驱动与销毁 |
| [driver Inbox](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/inbox.ts) | durable splice 的 projection 与 claim |
| [SDK API](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/api.ts) | matching receipt 到 root idle 的 activity interval |

### 所有权与 Context

`ctx.agents.create()` / `resume()` 返回 `{ agent, dispose }`；目录查询只给 live Agent，不转交 dispose 权限。AgentLoop 创建 unpublished Session/Agent，运行 setup，发布 registry identity，并等待 serial `agent/created` 初始化；初始化结束前不执行排队工作，失败会 rollback。

`agent.ctx` 是 Agent 的贡献作用域；AgentLoop 保存自身依赖 context（私有 `runtime.ctx` / driver 的 `loopCtx`），不能因调用方 shadow 就换成另一组驱动依赖。`agentEvents(ctx, agent)` 将 event subject 与 scope carrier 绑定，`assembleContextFor(agent, signal)` 传递一致的 Agent/assembly scope。`ctx.agents.withInitiator()` 用进程内 async scope 表示当前工作的发起者；`withoutInitiator()` 可清除共享后台工作上的误归属。initiator 不替代明确的输入字段，也不自动拥有 detached task。

dispose 共享一次回收：停止 driver、等待 quiescence、撤销 Agent scope，完成持久化写路径收尾和 registry解绑。正常业务代码应调用 holder 的 dispose，而不是直接删 registry 项目。`resume()` 通过 persistence 的 `open(id, 'write')` 先取得写 ownership，再读取和修复中断历史，完成 setup 后发布 Agent；不再使用旧 `sessionPersistence.prepare()` 接口。

### 队列与唤醒

| 方法 | target | idle 时 | 消费点 |
| --- | --- | --- | --- |
| `followup(message)` | next-turn | 唤醒 | 每个 ordinary input 独占一轮 |
| `steer(message)` | next-step | 唤醒 | 最近未 claim 的 step |
| `inject(message)` | next-step | 不唤醒 | 等待后来的 waking input / 活跃 step |

Inbox 由 `agent/inbox/spliced` 重建；mutation 先提交 splice，再更新队列和 live 通知。claim 取全部 next-step，再视 target 取一个 next-turn；被 claim 不意味着一定进入模型，`agent/pre-step` 可以拒绝或改写输入。被拒绝的首批输入可能留下没有 step 的 turn。

```mermaid
sequenceDiagram
    participant C as Caller
    participant A as Agent / Inbox
    participant L as AgentLoop
    participant S as Session
    C->>A: inject identified message
    A->>S: inbox splice
    Note over A,L: idle remains idle
    C->>A: followup identified message
    A->>S: inbox splice
    A->>L: wake
    L->>S: turn/start
    L->>A: claim next-step + one next-turn
    L->>L: assemble + agent/pre-step
    L->>S: admitted step and messages
    L->>S: assistant settlement / tools / turn/end
    L-->>C: whole-agent idle
```

一个 running interval 可以覆盖多轮。`whenIdle()` 等待整个 driver 与 maintenance，包括原 driver 退出前接续的工作；不返回某条 message 的结果。maintenance 对外状态可为 idle，但 `whenIdle()` 仍会等它和其后释放的输入。

SDK 的 `run()` 先匹配 root `agent/inbox/spliced` 中的 messageId，再观察到 root idle。它会包含期间的 steering 或注入；`finalResponse` 是区间内最后一条已提交 root assistant 文本，不能把 messageId 当作业务 Run ID。

## Observed at runtime

2026-09-29 从仓库根目录执行：

```sh
node --test --test-name-pattern='inbox waits' how-dsh-works/probes/published-core.test.mjs
```

本次完整 [published-core probe](probes/published-core.test.mjs)为 3/3 passed；上述 case 使用真实发布库与确定性 adapter，观察 idle inject 不开 turn、followup 同步 running、注入内容先于 waking input 进入请求、whenIdle 后提交 V4 assistant。它未启动 DSH 子进程、未联网或调用模型。安装前置条件见[目录说明](README.md#新版证据与重跑)。

## Inference、Proposal 与未确认

Inference：业务服务需要独立 Run 和 admission 所有权；单独读 status 不足以判断 prompt 结算。Proposal：为重叠 followup、maintenance 和取消继续增加受控时序实验。本次未验证全部这些竞争、初始化失败 rollback 或真实 SDK 并发；旧三项 loop probes 仅保留在[历史记录](historical-2026-08-31.md)。
