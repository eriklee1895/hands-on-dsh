# Python SDK 与 TypeScript SDK

本文比较本仓库实际锁定并验证的两个已发布 client surface：Python 教程使用 `deepseek-harness-sdk==0.1.1rc1`（tag `dsh-v0.1.1-rc.1`），TypeScript 教程使用 `@deepseek-ai/dsh-sdk-client@0.1.1-rc.2`（tag `dsh-v0.1.1-rc.2`、commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`）。它们不是一次同版本 benchmark；本文比较集成方式，不把一个语言或 release 的包装能力推断到另一个。

## 先给结论

- Python 适合最快开始本地 Agent 应用：SDK wheel 提供 Python 风格的 bundled-runtime resolver，`uv` 项目可以直接从高层 API 起步。
- TypeScript 适合 Node BFF 和后续 React/full-stack：已发布的 `@deepseek-ai/dsh-sdk-client` 同时提供高层 `DeepSeekHarness` 和底层 `HarnessClient`，但调用方必须显式提供 runtime command、args、cwd 和完整子进程环境。
- 两者在各自锁定 release 上都投影 SDK JSON-RPC runtime；raw JSON-RPC 不能增加服务器没有的 cancel 或 approval 语义。
- 需要 ACP 的即时 cancel/permission 时，选择 ACP adapter，而不是因为语言不同就假设 SDK JSON-RPC 获得了这些控制。

## 能力矩阵

| 维度 | Python SDK | TypeScript SDK |
| --- | --- | --- |
| 本仓库固定版本 | `deepseek-harness-sdk==0.1.1rc1` | `@deepseek-ai/dsh-sdk-client@0.1.1-rc.2` |
| 高层 API | `DeepSeekHarness`、session、`run()` | `DeepSeekHarness`、`HarnessSession`、`run()` |
| 底层 API | `HarnessClient` | `HarnessClient` |
| runtime 获取 | wheel 提供 bundled runtime resolver | npm client 不提供 Python 式 bundled-runtime resolver |
| runtime 启动 | resolver 产生 launch，再由 SDK 拉起子进程 | 调用方显式传入 `launch.command/args/cwd/env` |
| 流式观察 | `on_notification` callback | `onNotification` callback 或 subscription |
| 结算 | matching inbox receipt 到 whole-agent idle | matching inbox receipt 到 whole-agent idle |
| session 复用 | 同一 harness/runtime 和稳定 session ID | 同一 harness/runtime 和稳定 session ID |
| 低层通知 | SDK JSON-RPC session/subagent notifications | SDK JSON-RPC session/subagent notifications |
| cancel / approval | SDK JSON-RPC 不提供 | SDK JSON-RPC 不提供 |
| 推荐项目工具 | uv、Ruff、pytest | pnpm、strict TypeScript、Vitest、Oxlint/Oxfmt |

## Runtime 启动差异

Python 教程可以从 wheel 自带的 runtime 解析开始；TypeScript 教程必须把 runtime 当作显式部署依赖。本仓库的 TypeScript 示例因此只接受固定 rc.2、tracked-clean、已经 fresh build 的 upstream checkout，并验证：

```text
HEAD / tag / package version
  -> built jsonrpc bin + minimal cordis.yml
  -> replacement child env
  -> DeepSeekHarness or HarnessClient
```

TypeScript 的显式启动不是“没有 SDK”。高层 API 已发布且经过真实模型验证；缺少的是 Python 风格的 runtime 分发/解析层。部署时仍应把 runtime 版本、配置和进程监督作为应用拥有的依赖。

## 流式与低层控制

两个高层 SDK 都通过 callback 观察 notification stream。TypeScript 教程把 root `assistant/chunk` 的 `text-delta` 投影为实时文本，同时保留 tool、subagent 和 running/idle 计数；最终答案仍来自 committed `assistant/message`。

底层 `HarnessClient` 适合学习或实现自有 adapter：先 subscribe，再 prompt；prompt response 只返回 inbox message identity；客户端必须丢弃 matching receipt 之前的全部通知，并等下一次 root idle。它不是持久业务 Run，也不提供 wire cancel。

## 已验证范围

2026-08-31 的 fresh gate 完成：

- Python rc.1 教程的六个真实 API 示例与 FastAPI 浏览器链路；
- TypeScript 的四个真实 rc.2 source-runtime 示例；
- TypeScript 两轮 session 返回唯一 nonce；
- TypeScript tool 示例由外部进程核对 34 字节 artifact 和 SHA-256；
- 正常关闭后，外部进程表确认所有当次观察到的 runtime/descendant PID 消失；
- TypeScript keyless suite 覆盖协议 transcript、错误、deadline、环境清理和直接 runtime 回收。

正常关闭的进程表观察不能扩展为异常 descendant-tree 保证：rc.2 npm client 只直接拥有 runtime 子进程，没有 detached process-group handle。

## 如何选择

优先 Python，当你的目标是快速熟悉 DSH、编写后端服务或沿用现有 Python/uv 工程。优先 TypeScript，当 DSH 将运行在 Node BFF 中，后续要对接 React、AG-UI 或 CopilotKit，并且团队愿意显式管理 runtime artifact 和进程生命周期。

无论选择哪一个，都让业务 `Conversation / Run / Artifact` 保持权威；DSH session ID 只是 runtime 引用。协议控制要求优先于语言偏好：需要 ACP 语义时单独使用 ACP adapter。

## 真源

- Python 教程：[`tutorials/python-sdk`](../../tutorials/python-sdk/README.zh.md)
- TypeScript 教程：[`tutorials/typescript-sdk`](../../tutorials/typescript-sdk/README.md)
- 协议比较：[SDK JSON-RPC 与 ACP](sdk-jsonrpc-vs-acp.md)
- 固定源码入口：`python/sdk/src/deepseek_harness/`、`packages/sdk/client/src/`、`packages/sdk/protocol/src/`

在这个固定 revision，官方站点有 Python SDK guide，但没有对等的 TypeScript SDK quickstart；TypeScript 结论以发行包声明、固定 tag 源码和本仓库运行证据为准。
