# TypeScript Runtime Builder

目标：理解 wire 语义，用公开 SDK profile 管理 runtime，再进入 Cordis/preset、AG-UI 应用和内部机制。当前 SDK、protocol lab、Cordis 与 AG-UI 都固定 DSH `0.1.7-rc.2`；Python 的发行版本独立。这条路线最终会把一个工具调用接到浏览器，并在 runtime 重启后继续同一段对话；[执行记录](../reviews/2026-09-29-plugin-agui-internals.md)保存实际验证范围。

## 1. 协议语义

完成 [protocol-semantics](../../labs/protocol-semantics/README.md)：SDK initialize/prompt/receipt-to-idle；ACP 持久 session list/resume/close、配置选项、cancel 与 permission。理解 JSONL 双向 request ID、committed 输出和 closeOutcome。Raw client 不能增加 server 缺失的方法。

## 2. TypeScript SDK

完成 [typescript-sdk](../../tutorials/typescript-sdk/README.md) 的四例：通过同版本 npm dsh 启动、复用 runtime/session、观察 root committed messages 与工具，以及底层 HarnessClient。使用公开 profile/home/patch；源码 checkout 和旧 demo bin 不再是运行前提。

运行 frozen install、keyless tests、typecheck、lint、format，再逐例验证真实回复、代号回读、外部工具字节与进程回收。通知流不等于逐 token streaming；不要把固定版本没有下发的实时帧模拟成已支持。

## 3. Python 与 TypeScript

阅读[SDK 对照](../comparisons/python-vs-typescript-sdk.md)：Python 平台 runtime wheel 与 Node/npm CLI 不同；两侧 env 语义、可用发行版本与模型 endpoint 也不同。应用仍需拥有 home、workspace、配置、进程与业务状态。

## 4. Cordis 与 preset

完成 [cordis-plugin-lifecycle](../../labs/cordis-plugin-lifecycle/README.md)：Context、Service/inject、typed events/waterfall、effect teardown、HMR/PENDING、proof tool 与结果 listener。新版保留稳定 `./tool`、`./listener`，通过 packed consumer 和真实 profile 验证消费。

先观察依赖服务移除后 consumer 如何停止，再把工具安装到限定作用域。Preset probe 验证声明的 proof-only 子插件 composition 可以解析且不泄漏全局工具。它不等于完整 Agent activation、热更新或 sandbox 验收。历史官方七章的运行只属于原版本，当前原创 package 的验证单独记录。

## 5. AG-UI Full-stack

[ag-ui-dsh-runtime](../../projects/ag-ui-dsh-runtime/README.md) 使用 Fastify BFF、React/CopilotKit 和 SQLite。AG-UI SSE 显示消息/工具；独立 business cursor stream 负责断线回放。前端断开不等于后端运行取消，状态与 Artifact 仍以数据库为准。

公开 `sdk-minimal` profile 通过有序 patch 加载编译后的工具、listener 和 deployment adapter。Adapter 通过 persistence.stat 的 header 核对 canonical cwd，再调用 agents.resume；stock SDK 仍没有 resume RPC。切换 runtime generation 不旋转已知的 Session ID，关闭失败必须阻止替代进程。模型 max-tokens/error 不能因为存在工具产物就被记为业务成功。

动手时沿一条连续任务检查：创建 Conversation，要求写出产物，断开页面后从 business cursor 补读，再重启 runtime 回忆之前的代号。每一步都核对 SQLite、Session 和实际文件各自留下什么。两 Conversation、跨 generation、foreign-cwd 与桌面/375px 浏览器的历史验收详见[项目记录](../reviews/2026-09-29-plugin-agui-internals.md)。

## 6. 核心机制与工程化

进入 [how-dsh-works](../../how-dsh-works/README.md) 的七篇新版源码笔记。它们区分固定源码事实与已运行 probe：新库级 probes 覆盖 Inbox/live/embedded stream、V4 工具失败与 context snapshot；[compaction](../../labs/compaction-lifecycle/README.md)、[workflow/child](../../labs/workflow-child-lifecycle/README.md)、[官方Web Host](../../labs/web-host-lifecycle/README.md)与[附件](../../labs/attachment-input/README.md)已有独立新版运行证据，各章仍保留具体未覆盖范围。

[Session 格式实验](../../labs/session-format-migration/README.md)解释逻辑 read 与磁盘 write 的差别；[恢复对照](../comparisons/recovery-and-session-migration.md)区分业务恢复、会话恢复和格式升级。接着按[工程化路线](engineering.md)学习超时、并发、隔离和评测；这些课程已有对应实验和限定场景验证。
