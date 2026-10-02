# 有界 runtime 池执行计划

> **For agentic workers:** Use dispatching-parallel-agents for the separate implementation and teaching files after agreeing the interface; TDD and independent review required.

**Goal:** 完成 Phase 7.2 的有界请求池、故障演示与真实双 runtime 验证。

**Architecture:** 组合现有 RuntimeSupervisor，池拥有排队与 slot 分配，SDK 拥有具体进程关闭；业务状态仍在调用方。

**Tech Stack:** Node ^22.19 || >=24、TypeScript strict/NodeNext、pnpm12.3.4、Vitest、发布 SDK0.1.7rc2。

**Spec:** [设计](../specs/2026-09-29-runtime-pool-design.md)

## Global Constraints

- checkpoint `4b4bf77`，不改 upstream 或其他项目，不新增依赖。
- 不重放失败 prompt；回收确认前不释放 slot；隔离 owner 不替换。
- queueSignal 仅取消排队；close 拒绝排队并 drain active。
- 默认 SDK 工具在真实池演示中禁用；独立 home/workspace；输出不含 key。

## Review Focus

- slot 释放微任务与新 admission 竞争、FIFO 与 timer 回调延迟。
- queue abort 的 dispatch 前后语义，listener/timer 清理。
- 全隔离、部分降容、close 失败和多个 close caller。
- 重复 owner factory 返回值，不能关闭其他 slot 的活跃 owner。
- 演示必须验证 terminal、无工具、并发进程与回收，不把 fake 当真实故障保证。

### Task 1: Pool 代码与测试

**Files:** `labs/runtime-supervision/src/pool.ts`、`tests/pool.test.ts`。

**Interfaces:** 按设计实现 RuntimePool / PoolRunResult / snapshot 与六种错误；复用现有 OwnedRuntime/RuntimeSupervisor，不改其行为。

- [x] 写行为回归并观察 RED，覆盖设计中的容量/取消/故障/关闭规则。
- [x] 实现最小调度状态机，保证 slot 独占直到 run 结算。
- [x] scoped tests、既有 supervisor 回归、typecheck/lint/format。

### Task 2: 演示与教程

**Files:** `examples/pool-faults.ts`、`examples/pool.ts`、`POOL.md`、README/package scripts、共享导航与 `docs/reviews/2026-09-29-runtime-pool.md`。

**Interfaces:** 使用 Task 1 API；原 7.1 命令和源码保持。

- [x] 无凭据故障演示和中文运行步骤，解释每个观察结果。
- [x] 真实双 owner 四请求、容量快照、completed/精确文本/无工具验证，外部进程观测。
- [x] 独立 review 并修复，记录真实/fake 范围、更新 7.2 状态，检查后本地提交。
