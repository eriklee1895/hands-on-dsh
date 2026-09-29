# 工程化学习路线

目标是把“能调用 Agent”推进到“能解释并验证失败后的行为”。先读[2026-09-28 上游审查](../reviews/2026-09-28-upstream-refresh.md)，按各章实际 pin 运行。Phase 1–6 的历史完成状态不等于新版迁移完成。

## 课程与验收

| 单元 | 前置 | 作品 | 必须观察到的结果 | 状态 |
| --- | --- | --- | --- | --- |
| 7.1 单 runtime 的所有权与超时 | 新版 profile/home、receipt-to-idle | [runtime-supervision lab](../../labs/runtime-supervision/README.md) | 只接纳一个调用；失败不重放；close 成功才重建；close 失败隔离 | 已完成，证据见执行记录 |
| 7.2 进程池与容量控制 | 7.1、业务 Run | 扩展 supervisor lab | 队列上限、拒绝/等待策略、独占 lease、崩溃后释放；不自动重跑不确定任务 | 待做 |
| 7.3 身份认证与租户 | 业务状态、7.2 | 扩展 recoverable service | 伪造 tenant/session ID 被拒绝；跨租户 artifact/event 不可读；凭据不进入日志 | 待做 |
| 7.4 Workspace 与执行隔离 | 7.3 | sandbox isolation lab | 允许目录与禁止目录的真实工具探针；网络、进程、清理边界；平台差异单列 | 待做 |
| 7.5 可观测性与成本 | V4 事件迁移、7.1 | Run timeline/usage/audit | 区分业务 run、session/turn、provider attempt；重放不重复计费；敏感内容脱敏 | 待做 |
| 7.6 Eval 与可重放回归 | 事件投影、7.5 | 固定输入/预期的 keyless fixture 集 | 成功、工具错误、取消、断线、resume 均有验收；真实 provider 结果独立 | 待做 |
| 7.7 跨 runtime 适配 | 协议课、7.6 | DSH/ACP 共同场景，随后接入其他 runtime | 逐项标记支持/不支持；不能用统一接口伪造 cancel/approval/resume | 待做 |

## 与旧课程升级的关系

7.1 只依赖公开的 run/close，先独立完成。旧 Python/TS 入门随后迁移，事件与持久化升级排在 AG-UI 前；7.2 复用已有业务状态模型，7.3–7.7 再依次扩展。每课包含：问题、固定版本、可执行示例、故障实验、观察记录、边界与下一步。

新版迁移清单：

- [x] Python：入门已迁移到 `0.1.5rc1`，公开 profile/home 启动并重新实跑六例；验收见 [SDK 迁移记录](../reviews/2026-09-28-sdk-migration.md)。
- [x] TypeScript：入门已迁移到 `0.1.7-rc.2`，公开 profile/home/patch 启动、committed-message 投影与四例验证；同上记录。
- [x] 协议与 FastAPI：公开 profiles、SSE 已提交消息投影与 ACP 持久会话控制，见[第三批验收](../reviews/2026-09-29-web-protocol-migration.md)。
- [ ] 真正的实时 token transport：另行选择并验证，当前 SDK/ACP 教程不提供。
- [x] Session V4 基础实验：synthetic plaintext V1/V3 副本的只读迁移、写入 successor 与不可变 generation，见[第四批验收](../reviews/2026-09-29-recovery-storage.md)。
- [ ] 更复杂历史数据：压缩历史日志、附件、子会话 catalog 和实际版本采集样例；当前最小 fixture 不代表这些已覆盖。
- [x] 可恢复服务升级：Python `0.1.5rc1`、旧事件原样重放、reconciliation/恢复确认和产物/幂等兼容，与 Session 格式分开验收。
- [ ] Cordis/preset：公开 profile patch、plugin package 安装与 effect teardown。
- [ ] AG-UI：重新审计 resume adapter、流式 projector、跨 generation 与浏览器重连。
- [ ] 核心机制：逐篇重跑新版 probes，替换已变化的事实；旧证据保留日期。

先读[业务恢复、会话恢复与格式迁移](../comparisons/recovery-and-session-migration.md)，避免把底层可读或 resume 成功当成业务执行成功。

每次只把实际验收的单元标为完成。[执行记录](../reviews/2026-09-28-execution.md)保存本批结果与明确的后续起点。
