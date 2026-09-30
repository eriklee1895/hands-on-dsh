# 工程化学习路线

目标是把“能调用 Agent”推进到“能解释并验证失败后的行为”。先读[2026-09-28 上游审查](../reviews/2026-09-28-upstream-refresh.md)，按各章实际 pin 运行。Phase 1–6 的历史完成状态不等于新版迁移完成。

## 课程与验收

| 单元 | 前置 | 作品 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- | --- |
| 7.1 单 runtime 的所有权与超时 | 新版 profile/home、receipt-to-idle | [runtime-supervision lab](../../labs/runtime-supervision/README.md) | 只接纳一个调用；失败不重放；close 成功才重建；close 失败隔离 | 已完成，证据见执行记录 |
| 7.2 进程池与容量控制 | 7.1、业务 Run | [有界 runtime 池](../../labs/runtime-supervision/POOL.md) | 有界 FIFO、独占 lease、排队取消、故障回收与隔离；不自动重跑不确定任务 | 已完成，[32 项测试与真实双进程验收](../reviews/2026-09-29-runtime-pool.md) |
| 7.3 身份认证与租户 | 业务状态、7.2 | [租户认证入口](../../projects/recoverable-agent-service/TENANCY.md) | 伪造身份字段被拒绝；跨租户读写/事件/产物不可访问；认证 token 不进入业务存储和服务日志 | 已完成，[171 项测试与双租户 HTTP/模型验收](../reviews/2026-09-29-tenant-auth.md) |
| 7.4 Workspace 与执行隔离 | 7.3 | [sandbox isolation lab](../../labs/sandbox-isolation/README.md) | 真实 provider/模型工具验证写入限制；读取、网络、进程与清理逐项观察 | 本机课程已完成，[验收记录](../reviews/2026-09-29-sandbox-isolation.md)；容器/远程执行待扩展 |
| 7.5 可观测性与成本 | V4 事件迁移、7.1 | [Run 观测 lab](../../labs/run-observability/README.md) | 区分 Run/turn/attempt；重放不重复计数；白名单元数据与明确缺失项 | 已完成，[16 项测试与双 Run 验收](../reviews/2026-09-29-run-observability.md)；非供应商账单 |
| 7.6 Eval 与可重放回归 | 事件投影、7.5 | [可恢复服务 Eval](../../projects/recoverable-agent-service/EVAL.md) | 成功、工具错误、已结算 aborted、执行不确定和业务恢复；游标重放及负对照 | 已完成，[五受控案例/251 项测试与独立真实成功验证](../reviews/2026-09-30-eval-regression.md)；不提供 cancel/SDK 冷恢复 |
| 7.7 跨 runtime 适配 | 协议课、7.6 | [DSH 双协议适配基础](../../labs/protocol-semantics/ADAPTERS.md) | 保留原生终态、显式能力、共享关闭与共同场景 | 基础已完成，[109 项测试与双 profile 验收](../reviews/2026-09-30-runtime-adapters.md)；其他引擎未接入 |

## 与旧课程升级的关系

7.1 只依赖公开的 run/close，先独立完成。旧 Python/TS 入门随后迁移，事件与持久化升级排在 AG-UI 前；7.2 组合 supervisor 并把业务幂等留给调用方，7.3–7.7 再依次扩展。每课包含：问题、固定版本、可执行示例、故障实验、观察记录、边界与下一步。

新版迁移清单：

- [x] Python：入门已迁移到 `0.1.5rc1`，公开 profile/home 启动并重新实跑六例；验收见 [SDK 迁移记录](../reviews/2026-09-28-sdk-migration.md)。
- [x] TypeScript：入门已迁移到 `0.1.7-rc.2`，公开 profile/home/patch 启动、committed-message 投影与四例验证；同上记录。
- [x] 协议与 FastAPI：公开 profiles、SSE 已提交消息投影与 ACP 持久会话控制，见[第三批验收](../reviews/2026-09-29-web-protocol-migration.md)。
- [ ] 真正的实时 token transport：另行选择并验证，当前 SDK/ACP 教程不提供。
- [x] Session V4 基础实验：synthetic plaintext V1/V3 副本的只读迁移、写入 successor 与不可变 generation，见[第四批验收](../reviews/2026-09-29-recovery-storage.md)。
- [ ] 更复杂历史数据：压缩历史日志、附件、子会话 catalog 和实际版本采集样例；当前最小 fixture 不代表这些已覆盖。
- [x] 可恢复服务升级：Python `0.1.5rc1`、旧事件原样重放、reconciliation/恢复确认和产物/幂等兼容，与 Session 格式分开验收。
- [x] Cordis/preset：固定新版公开 profile patch、packed plugin、effect teardown 和 preset composition probe。
- [x] AG-UI：重新审计 SDK deployment resume adapter、V4 committed projector、公开 package runtime、跨 generation 与浏览器 hydration。
- [x] 核心机制正文：七篇按固定新版源码更新，3 个新公开库 probe 和相关 lab 证据，旧结果独立归档。
- [x] Compaction基础运行验证：[确定性engine与真实pressure实验](../../labs/compaction-lifecycle/README.md)，包含后续产物和持久surface重放。
- [x] Workflow/PTC 与 child 冷恢复基础：[运行 Lab](../../labs/workflow-child-lifecycle/README.md)，包含受控取消清理、真实文件和正常关闭后的双进程恢复。
- [x] 官方 Web Host 基础：[浏览器 Lab](../../labs/web-host-lifecycle/README.md)，包含认证、实时帧、历史加载、正常重启后同会话续写与文件验证。
- [ ] 核心机制剩余运行验证：compaction overflow/取消/prune/offload、PTC crash/复杂并行/retry、child 冷恢复森林、Web 中途断网/cancel/approval/crash；见逐篇证据表。

先读[业务恢复、会话恢复与格式迁移](../comparisons/recovery-and-session-migration.md)，避免把底层可读或 resume 成功当成业务执行成功。

每次只把实际验收的单元标为完成。[执行记录](../reviews/2026-09-28-execution.md)保存本批结果与明确的后续起点。
