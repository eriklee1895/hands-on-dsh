# 从能运行到能解释失败

最小 SDK 示例通常只运行一次。服务则要连续接纳请求，还要回答超时后发生了什么、进程何时能再次使用、谁可以读取任务，以及日志重放会不会重复计数。这七课沿这些实际问题展开。

先完成一条 [Python](python-app-builder.md) 或 [TypeScript](typescript-runtime-builder.md)基础路线，理解 runtime、Session 与业务 Run。各课以自身 manifest/lockfile 为准；Python 服务与 npm 机制实验的版本独立，迁移背景见[上游审查](../reviews/2026-09-28-upstream-refresh.md)。

## 学习顺序与完成条件

| 单元 | 前置 | 作品 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- | --- |
| 7.1 单 runtime 的所有权与超时 | 新版 profile/home、receipt-to-idle | [runtime-supervision lab](../../labs/runtime-supervision/README.md) | 只接纳一个调用；失败不重放；close 成功才重建；close 失败隔离 | 已完成，证据见执行记录 |
| 7.2 进程池与容量控制 | 7.1、业务 Run | [有界 runtime 池](../../labs/runtime-supervision/POOL.md) | 有界 FIFO、独占 lease、排队取消、故障回收与隔离；不自动重跑不确定任务 | 已完成，[32 项测试与真实双进程验收](../reviews/2026-09-29-runtime-pool.md) |
| 7.3 身份认证与租户 | 业务状态、7.2 | [租户认证入口](../../projects/recoverable-agent-service/TENANCY.md) | 伪造身份字段被拒绝；跨租户读写/事件/产物不可访问；认证 token 不进入业务存储和服务日志 | 已完成，[171 项测试与双租户 HTTP/模型验收](../reviews/2026-09-29-tenant-auth.md) |
| 7.4 Workspace 与执行隔离 | 7.3 | [sandbox isolation lab](../../labs/sandbox-isolation/README.md) | 真实 provider/模型工具验证写入限制；读取、网络、进程与清理逐项观察 | 本机课程已完成，[验收记录](../reviews/2026-09-29-sandbox-isolation.md)；[Linux容器/SSH执行](../../labs/sandbox-isolation/CONTAINERS.md)与[验收](../reviews/2026-10-01-container-executor.md)已补齐 |
| 7.5 可观测性与成本 | V4 事件迁移、7.1 | [Run 观测 lab](../../labs/run-observability/README.md) | 区分 Run/turn/attempt；重放不重复计数；白名单元数据与明确缺失项 | 已完成，[16 项测试与双 Run 验收](../reviews/2026-09-29-run-observability.md)；非供应商账单 |
| 7.6 Eval 与可重放回归 | 事件投影、7.5 | [可恢复服务 Eval](../../projects/recoverable-agent-service/EVAL.md) | 成功、工具错误、已结算 aborted、执行不确定和业务恢复；游标重放及负对照 | 已完成，[五受控案例/251 项测试与独立真实成功验证](../reviews/2026-09-30-eval-regression.md)；不提供 cancel/SDK 冷恢复 |
| 7.7 跨 runtime 适配 | 协议课、7.6 | [DSH双协议与Codex/Hermes CLI适配](../../labs/protocol-semantics/ADAPTERS.md) | 保留原生终态、显式能力、共享关闭与共同场景 | 已完成，[DSH双profile验收](../reviews/2026-09-30-runtime-adapters.md)与[137项测试、Codex/Hermes真实验收](../reviews/2026-10-02-cross-engine.md)；各入口保留原生能力差异 |

## 让前一课的问题带出下一课

先管理一个 runtime：请求超时之后，等待自有进程回收，再决定能否重建。有了这个规则，进程池才知道什么时候能归还 slot，而不会在旧任务仍执行时把它借给下一位调用者。

再加入身份。租户 API 把调用者映射到自己的数据库、workspace 和 runtime；随后 sandbox 与容器实验告诉你，这种数据路由与操作系统隔离分别能限制什么。alpha 的 API 读不到 beta 的记录，并不自动证明任意工具都无法读到宿主数据。

最后把结果记录下来。观测课按 Run、Session 与 attempt 解释事件和 usage；eval 将这些观察转成可重放的判据。跨引擎适配保留每个入口的原生终态，避免同一个 `prompt()` 名字掩盖复用、关闭与恢复的差异。

## 与机制实验配合

遇到具体的不确定行为，可以插入一组更小的实验：

- 数据仍在但恢复失败：先区分[业务恢复、Session恢复与格式迁移](../comparisons/recovery-and-session-migration.md)，再做[复杂历史](../../labs/session-format-migration/RICH-HISTORY.md)与[child forest](../../labs/workflow-child-lifecycle/RECOVERY.md)。
- 压缩或附件处理失败：沿[compaction](../../labs/compaction-lifecycle/README.md)与[附件输入](../../labs/attachment-input/README.md)检查原始事件、模型输入、持久提交与外部对象。
- 页面失去响应：用[官方 Web 控制](../../labs/web-host-lifecycle/CONTROLS.md)和[恢复实验](../../labs/web-host-lifecycle/RECOVERY.md)区分取消、断线、重复提交与 Host 崩溃。

上表课程和列明扩展已有运行材料；具体版本、负面结果与未覆盖范围见[全章验收索引](../reviews/2026-10-01-chapter-audit.md)。学习时按各章条件复现，自己的结果与历史样本不同，就保留观察并分析原因。
