# 可恢复服务与 Session 格式迁移执行计划

> **For agentic workers:** Use dispatching-parallel-agents for independent directories, TDD for behavior changes, then independent review.

**Goal:** 新版业务恢复项目可运行，并通过官方 persistence backend 验证历史日志升级。

**Architecture:** Python 服务保持 SQLite 业务权威；独立 Node lab 只操作自建 fixture 副本，官方包拥有 codec/迁移逻辑。

**Tech Stack:** Python >=3.10、uv/pytest/Ruff；Node ^22.19.0 || >=24.0.0、pnpm、TypeScript strict/NodeNext、Vitest。

**Spec:** [设计](../specs/2026-09-29-recovery-storage-design.md)

## Global Constraints

- 既有 checkpoint `6bf3f63`；固定 Python `0.1.5rc1` 与 npm `0.1.7-rc.2`。
- 不改真实用户数据库/session；旧 business event 原样重放。
- 不自动重试不确定执行；不把数据格式迁移等同于业务/模型恢复。
- 子任务只改自己目录，不 stage/commit/push；协调者提交完整增量，不推送。

## Review Focus

- 取消异步 waiter 不可释放仍在工作的线程/owner，close 失败不得重建。
- 新 committed message 不伪装为 delta；旧数据库 text_delta 不被改写。
- 新版服务首次打开旧 SQLite 不丢 RunEvent/Artifact/幂等事实。
- 迁移只读阶段不落盘；写失败不能覆盖原文件或把 corrupt latest 当作旧版 fallback。
- source hash、successor 文件和 logical history 都要检查，不能只验 version=4。

### Task 1: Recoverable Agent Service

**Files:** `projects/recoverable-agent-service/`。

**Interfaces:** adapter 采用公开 home/profile；新增 assistant_message 事件；原 HTTP/SSE/SQLite 接口保留业务语义。

- [x] 写失败回归并迁移 dependency、adapter、投影、配置及所有消费者。
- [x] 保留旧事件重放、启动 reconciliation、恢复确认/旋转与 immutable Artifact；修复必要生命周期风险。
- [x] keyless/3.10/Ruff/lock，真实 E2E 与外部进程检查；更新 README。

### Task 2: Session Format Migration Lab

**Files:** 新增 `labs/session-format-migration/`。

**Interfaces:** 固定 fixture 输入，公开 backend open(read/write)，输出源/目标版本、hash、文件列表和 logical 语义结果。

- [x] 检查固定包 API 与格式，制作最小 V1/V3 fixture，明确 synthetic 性质。
- [x] RED/GREEN：非空消息、read-only、immutable predecessor、write successor、重复打开、future/corrupt 拒绝。
- [x] 实跑发布 backend 的 demo/tests，typecheck/lint/format/lock；写中文教程与范围。

### Task 3: 整合与记录

**Files:** root README、projects/labs 导航、learning paths、`docs/reviews/2026-09-29-recovery-storage.md`。

- [x] 独立 review 两个目录，修复重要问题并运行对应回归。
- [x] 更新课程完成状态，区分业务恢复、格式迁移和 ACP resume。
- [x] 检查链接/Mermaid/diff/凭据，记录实际命令和未覆盖范围，提交本地 commit。
