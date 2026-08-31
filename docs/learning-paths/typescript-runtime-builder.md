# TypeScript Runtime Builder

目标：理解 DSH 的 wire 语义后，用已发布 TypeScript SDK 显式管理 runtime，再进入 Cordis/plugin 和 full-stack Agent 应用。

## 1. 协议语义

先完成 [`labs/protocol-semantics`](../../labs/protocol-semantics/README.md)：

- SDK JSON-RPC 的 initialize、prompt、notification、receipt-to-idle 和 shutdown
- ACP 的 initialize、session、cancel 与 permission
- JSONL framing、request correlation、typed close outcome
- 为什么 client adapter 不能增加 server 没有的语义

不要在 TypeScript 阶段再实现第二套 raw transport；只保留一项与 Python lab 对齐的 parity smoke。

## 2. TypeScript SDK

完成 [`tutorials/typescript-sdk`](../../tutorials/typescript-sdk/README.md)：

1. 显式验证并启动固定 rc.2 source runtime；
2. 复用一个 harness/runtime 和稳定 session；
3. 投影 root text delta、tool、subagent 与生命周期通知；
4. 使用底层 `HarnessClient` 完成 receipt-to-idle。

本阶段门槛是：pnpm frozen install、48 个 keyless 测试、typecheck、lint、format 全部通过；四个真实模型示例结束后 `.runtime` 为空，外部进程表确认正常关闭的 runtime 和当次观察到的 descendant 全部消失。

## 3. Python 与 TypeScript 边界

阅读 [Python SDK 与 TypeScript SDK](../comparisons/python-vs-typescript-sdk.md)，确认 npm client 已有高层 API，但不携带 Python 式 bundled-runtime resolver。应用必须显式锁定 DSH revision、built artifact、Cordis 配置和子进程环境。

## 4. Cordis 与 Plugin（已完成）

先进入 Cordis/plugin，而不是直接堆叠 UI：

- `Context`、`Service`、`inject` 与 effect disposer
- typed events 与 waterfall `next()`
- `cordis.yml`、reload/teardown 和 PENDING
- 一个 model-callable tool plugin 与一个 session/tool observer plugin

官方七章 Cordis 教程在 disposable upstream scratch 中运行；个人仓库只保留原创实验和验证记录。

已完成 [`labs/cordis-plugin-lifecycle`](../../labs/cordis-plugin-lifecycle/README.md)：官方七章全部 keyless 实跑；原创 package 当前通过 25 个 keyless tests、packed plain-Node Loader consumer 和一次真实 model-callable tool gate。稳定复用入口是 package subpath `./tool` 与 `./listener`。

## 5. TypeScript Full-stack（已完成）

完成 plugin 阶段后构建 `projects/ag-ui-dsh-runtime`：TypeScript BFF 拥有 DSH runtime，React + CopilotKit/AG-UI 只消费稳定北向事件；业务 Conversation/Run/Artifact 和事件重放仍由应用层持有。

首版使用 SDK JSON-RPC adapter 保留详细工具/生命周期事件。ACP 继续作为独立 adapter/lab，不在首版混合两种 transport。

已完成 [`projects/ag-ui-dsh-runtime`](../../projects/ag-ui-dsh-runtime/README.md)：Fastify BFF 显式管理固定 rc.2 runtime；SQLite 持有 Conversation、Run、RunEvent 与 Artifact；React/CopilotKit 使用 bound `CopilotChatView` 和 AG-UI projector；business SSE 提供单调 cursor 重放。

实现过程中真实 gate 发现 stock rc.2 SDK JSON-RPC server 在进程重启后固定 fresh-create，opaque session ID 相同但模型历史没有恢复。项目没有修改 upstream，而是增加 generation-local deployment adapter：复用官方 server，只把存在持久日志的 `agents.create` 映射为官方 `agents.resume`。keyless 双 Context/JSONL 测试证明 turn 1→2 与旧上下文进入第二次模型请求；真实 gate 进一步证明 runtime PID/generation 变化后同一 session 准确回忆 `ONYX-842`。

本阶段最终门槛已通过：19 files / 117 keyless tests、三 compiler faces、Oxlint/Oxfmt、server+web build、foreign-cwd adapter smoke；四个真实 Run 均恰好一次 tool/result 与 exact Artifact；两 Conversation、AG-UI detach/business replay、desktop/375px zero-violation Axe、idle restart 和记忆、最终进程回收均有外部证据。

## 版本与证据

- DSH：`0.1.1-rc.2`
- tag：`dsh-v0.1.1-rc.2`
- commit：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- TypeScript SDK 与 Cordis/plugin 真实验证日期：2026-08-31
- 安全边界：固定 minimal config 是 `danger-full-access`；disposable workspace 不是 sandbox
