# How DSH Works

这里从自学视角解释 DSH 为什么这样运行。内容不逐文件翻译源码，而是围绕可观察机制记录入口、调用路径、最小探针与版本边界。

本轮研究统一固定到：

- DSH tag：`dsh-v0.1.1-rc.2`
- revision：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- 验证日期：2026-08-31

每篇都明确区分 `Verified from source`、`Observed at runtime`、`Inference`、`Proposal` 与 `Unconfirmed / version boundary`。源码链接固定到完整 commit；probe 在同一 revision 的独立 upstream checkout 中实际运行。后续升级 DSH 时，应重新审计入口和测试，不能把这些 developer-preview 结论直接平移。

## 阅读顺序

| 顺序 | 机制 | 本轮 keyless 证据 |
| --- | --- | --- |
| 1 | [Plugin tree 与 runtime 组装](01-plugin-tree-and-runtime-assembly.md)：profile、bundle、Loader、fiber、inject 与 effect teardown | profile composition：1 selected test |
| 2 | [Agent Inbox 与 AgentLoop](02-agent-inbox-and-loop.md)：followup、steer、inject、receipt 与 whole-agent idle | loop input semantics：3 selected tests |
| 3 | [Turn、Step 与工具流水线](03-turn-step-tool-pipeline.md)：model request、tool scheduler、retry 与 outcome unknown | loop/tool ordering：2 selected tests |
| 4 | [Session Event Log 与 Projection](04-session-event-log-and-projection.md)：JSONL persistence、surface、derived messages 与 projection | persistence/projection：4 selected tests |
| 5 | [Compaction 与 Context Assembly](05-compaction-and-context-assembly.md)：request header、runtime snapshot、surface replacement 与摘要事务 | compaction + prompt/context：45 tests |
| 6 | [Subagent 与 Workflow](06-subagent-and-workflow.md)：one-shot、continuable Activation、worker bridge 与 durable run record | subagent/workflow：46 tests |
| 7 | [SDK JSON-RPC、ACP 与 Web Host](07-sdk-jsonrpc-acp-and-web-host.md)：三套面向不同调用者的协议/Host 语义 | SDK/ACP/Web carrier：170 tests |

交付前又把 7 篇引用的 21 个 upstream test files 作为一个 combined keyless regression 运行，结果为 603/603 passed。表中的数字仍保留每篇最小 probe 的证据范围，combined run 不是完整 upstream suite。

建议先完成 [`labs/cordis-plugin-lifecycle`](../labs/cordis-plugin-lifecycle/README.md)，亲手观察 `Context`、Service、effect、依赖重挂载、waterfall、HMR/PENDING、真实 tool 与 listener，再阅读第 1 篇；随后按表格顺序从 Agent 输入走到持久化、并发编排和外部协议。

## 内容边界

- 面向使用者的步骤留在 [`tutorials/`](../tutorials/README.md)。
- 单一语义与 protocol transcript 实验留在 [`labs/`](../labs/README.md)。
- 可恢复应用与 browser acceptance 留在 [`projects/`](../projects/README.md)。
- 本目录保存 source fact、runtime observation 与可以被后续 revision 推翻的推断，不复制 upstream 核心源码。
- 一篇 focused probe 只证明列出的路径；它不替代上游完整 suite、真实 provider、平台矩阵或生产安全审计。
