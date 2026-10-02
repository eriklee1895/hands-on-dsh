# DSH 教程更新执行计划

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. 用户要求整理计划后直接执行；此次范围是审查、路线和工程化第一课，后续课程保持明确待办。

**Goal:** 让读者知道旧教程哪些仍然适用，并完成基于已发布新版 SDK 的 runtime supervisor 实验。

**Architecture:** 固定发布版本，先核对源码和发布渠道，再独立验证一个 runtime slot。旧项目逐个迁移，保留已有证据的版本范围。

**Tech Stack:** Node、TypeScript、pnpm、Vitest、发布的 DSH SDK。

**Spec:** [设计](../specs/2026-09-28-curriculum-refresh-design.md)

## Global Constraints

- 新 lab 固定 DSH `0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`。
- Node `^22.19.0 || >=24.0.0`；TypeScript strict ESM/NodeNext。
- 仅通过公开 dsh profile 启动；不使用私有 client factory 或旧 package bin。
- 失败不自动重放 prompt；关闭失败拒绝新调用。
- 分别报告 keyless tests、真实进程 smoke、真实模型结果。
- 不 stage、commit、push；不修改上游 checkout。

## Review Focus

- timeout 后底层 promise 迟到：旧结果不能恢复 slot 或覆盖新 generation。
- close 与正在运行的调用竞争：停止接单，等待一次共享的 close，结果不可伪装为成功。
- SDK close 抛错：保留原始调用错误与回收错误，不创建替代进程。
- provider 失败可能作为 turn/end 返回：不能把 resolved promise 写成模型成功。
- 相对路径、空凭据和 cold profile 安装：真实 smoke 使用绝对独立 home，初始化超时与模型调用证据分别记录。

### Task 1: 上游审查与迁移路线

**Files:** Create `docs/reviews/2026-09-28-upstream-refresh.md`, `docs/learning-paths/engineering.md`.

**Interfaces:** 发布与源码事实供 Task 2 的版本锁定和 Task 3 的提示引用。

- [x] 核对 GitHub release、npm dist-tags、PyPI 和现有 lockfile。
- [x] 审查 launch、stream、session format、provider、preset、resume 与发布后 master 变化，写出受影响文件与验证要求。
- [x] 将 Phase 7 拆成有前置依赖、产物和验收条件的课程。

### Task 2: 单 runtime supervisor 实验

**Files:** Create `labs/runtime-supervision/{package.json,pnpm-lock.yaml,tsconfig.json,README.md}`, `src/supervisor.ts`, `examples/{handshake,run}.ts`, `tests/supervisor.test.ts`.

**Interfaces:** `OwnedRuntime` 只要求 `run(prompt: string): Promise<RunResult>`、`close(): Promise<void>`；`RuntimeSupervisor(factory, activityTimeoutMs)` 的 `run(prompt)` 只允许一个活动调用，暴露只读 state/generation；`close()` 终止接单并共享回收 promise。

- [x] 写行为测试并观察失败：复用与忙碌拒绝、活动 timeout、调用失败、隔离、显式重建、close 竞争、迟到完成。
- [x] 实现最小 supervisor，不复制 SDK 的 spawn/kill/JSON-RPC。
- [x] 写独立 home 的公开 profile smoke 和一次 prompt 示例。
- [x] 运行 tests、typecheck、lint、format，并通过发布包的 initialize/close。
- [x] 单独记录真实 prompt 的可执行条件和实际结果；不隐瞒发布阻塞。

### Task 3: 课程导航与验收记录

**Files:** Modify `README.md`, `labs/README.md`, `docs/README.md`, `docs/learning-paths/README.md` 及受影响教程/项目入口；Create `docs/reviews/2026-09-28-execution.md`.

**Interfaces:** 导航引用 Task 1 审查与路线、Task 2 lab，不复制实现。

- [x] 标明历史课程版本、第一课实际状态和仍未完成的迁移项目。
- [x] 检查相对链接、diff 空白、锁文件与所用命令，完成独立 review 并修复重要问题。
- [x] 将已执行命令、结果和下一步写入 execution 记录；保留未提交工作供继续。
