# 全章节验收索引

执行窗口：2026-10-01至2026-10-02，Asia/Shanghai。本轮从 `77f3fdd` 继续，目标是完成既有Phase 1–7、明确的剩余机制实验及三篇计划中的比较。实现与专项验收已完成，综合审查进行中。按[全章导航](../learning-paths/chapters.md)开始阅读，执行范围见[完成计划](../superpowers/plans/2026-10-01-complete-chapters.md)。

## 既有主体课程

| 课程组 | 入口 | 验收依据 |
| --- | --- | --- |
| Python SDK 6章 | [中文课程](../../tutorials/python-sdk/README.zh.md) | [固定0.1.5rc1迁移与六例实跑](2026-09-28-sdk-migration.md) |
| FastAPI 5章 | [课程](../../tutorials/fastapi-101/README.md) | [协议/Web迁移与浏览器验证](2026-09-29-web-protocol-migration.md) |
| TypeScript SDK 4例 | [课程](../../tutorials/typescript-sdk/README.md) | [固定0.1.7-rc.2迁移与四例实跑](2026-09-28-sdk-migration.md) |
| Cordis/plugin | [生命周期与preset](../../labs/cordis-plugin-lifecycle/README.md) | [26项测试、packed consumer与真实工具](2026-09-29-plugin-agui-internals.md) |
| 业务服务与AG-UI | [业务服务](../../projects/recoverable-agent-service/README.md)、[AG-UI](../../projects/ag-ui-dsh-runtime/README.md) | 迁移、租户、eval与跨generation的逐批记录，见各项目 |
| 机制7章 | [固定revision索引](../../how-dsh-works/README.md) | 发布库probe与下表各Lab独立证据 |
| 工程化7课 | [路线](../learning-paths/engineering.md) | supervisor、pool、认证、隔离、观测、eval与跨引擎逐项验收 |

这些已通过的真实运行保留原日期，没有为“全章完成”重复调用全部模型，也没有将旧证据改写成新运行。

## 本轮关闭的剩余项

| 原剩余范围 | 完成产物与证据 | 本轮相关检查 |
| --- | --- | --- |
| 图片预算与失效Files恢复 | [预算/offload](2026-10-01-attachment-budget.md)、[已删除ID恢复](2026-10-01-attachment-stale.md) | 附件Lab35项；真实图片请求、字节关联与自有远端对象清理 |
| 真实服务端overflow | [单次长输入验收](2026-10-02-provider-overflow.md) | 真实HTTP400与CONTEXT_WINDOW_EXCEEDED，0工具、12个V4事件 |
| 压缩历史、附件与版本采集 | [复杂历史](2026-10-01-rich-history.md) | 存储Lab16项；压缩V1/V3、真实V5头拒绝、发布版写出的V4附件样本 |
| child catalog与forest | [workflow恢复](2026-10-02-workflow-recovery.md) | workflow Lab18项；三节点V3迁移、不可变predecessor与第二进程冷恢复 |
| PTC崩溃/并行/重试 | [workflow恢复](2026-10-02-workflow-recovery.md) | 实际PTC SIGKILL、外部部分字节、受控并行上限与显式重试 |
| compaction持久化/并发失败 | [事务验收](2026-10-02-compaction-transactions.md) | compaction Lab36项；4个独立profile、25/25/25/15事件与完整重读 |
| 真正实时transport | [官方Web实时帧](2026-09-30-web-host.md) | 已有独立live帧早于committed message；不扩展为stock SDK/ACP能力 |
| Web断线、重复、审批、crash | [进阶验收](2026-10-02-web-recovery.md) | Web Lab11项；真实Host与关联后的迟到回答、随机ID负对照 |
| 容器与远程执行 | [Linux容器/SSH](2026-10-01-container-executor.md) | 11项本地测试；3项另行运行的真实Docker/SSH/provider测试 |
| Codex/Hermes适配 | [跨引擎验收](2026-10-02-cross-engine.md) | 协议Lab133项；双方真实文件与新严格nonce通过 |
| 三篇比较 | [Session/AG-UI](../comparisons/session-events-vs-ag-ui.md)、[SSE/WS](../comparisons/sse-vs-websocket.md)、[三引擎](../comparisons/dsh-codex-hermes.md) | 核对实际实现、原生终态与明确日期的运行记录 |

以上7个受影响Lab共执行260项本地测试；sandbox的3项Docker测试单独运行，不把默认跳过算作通过。每个变化目录均通过匹配的类型/lint/格式/依赖或构建检查，命令及范围以各验收记录为准。

## 保留的真实负面结果

- 本版本Web的串行同requestId可以识别，实测并发相同ID仍接纳两次；HTTP成功不是exactly-once保证。
- 本地fetch abort不能确定输入是否被接纳。Host崩溃修复得到TOOL_OUTCOME_UNKNOWN/interrupted时，外部文件也可能已存在。
- 迟到审批和随机event ID都可得到200/OK。最终验收用live frame、实际POST、回执与持久call的哈希关联，确认原审批保持cancelled。
- compaction调用失败可能已经留下checkpoint；flush-after有抛错前的真实读取，closing-marker保留未闭合start并拒绝同owner再次压缩。
- Hermes早期两个任务结果不明，没有包装为成功或自动重放。修复机器输出后用新任务验证，严格nonce修复后双方又各运行一个新nonce。

## 复核与边界

专项review发现的迁移断言、未来版本样本、容器清理/限制核对、CLI精确匹配/provider约束/凭据清理、worker回收及迟到审批关联问题，均已修正并经独立复核。源码只读核对固定DSH `477b4f420553e8a52c2fbccc464d7561b239c443`，没有修改upstream，也没有push。

全仓文档检查已通过：138篇Markdown、672个相对文件链接、44个Mermaid图，缺失文件0；锚点和外部URL可达性没有在该检查中验证。提交前做diff与凭据/个人绝对路径扫描。最终综合review及工作区状态将在关闭本计划时核对。

课程完成限定于各章给出的版本、机器、样本与验收条件；全平台、物理磁盘故障、完整网络/租户安全、任意执行中崩溃、通用视觉/摘要质量或完整供应商账单没有被新增为成功声明。这些限制保留在各章，不抹掉已进入本次完成计划的原始要求。
