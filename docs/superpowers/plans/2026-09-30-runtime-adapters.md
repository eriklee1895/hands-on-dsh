# Runtime adapter implementation plan

> **For agentic workers:** Use dispatching-parallel-agents for adapters/tests and separate common scenario CLI/docs. TDD and independent review required.

**Goal:** 完成7.7 DSH双协议能力适配与共同场景；其他引擎明确未接入。

**Architecture:** 既有Probe和OwnedState -> 能力明确Adapter -> 共同场景检查，保留native结算差异。

**Tech Stack:** Python3.10 stdlib/uv，npmDSH0.1.7rc2与既有lockfile，不改依赖。

**Spec:** [设计](../specs/2026-09-30-runtime-adapters-design.md)，本地commit授权继续，不push。

- [x] adapters.py/测试及SDKroot工具计数，RED/GREEN。
- [x] comparison.py共同fixture/负对照与CLI退出码，真实双profile prompt。
- [x] 中文ADAPTERS.md、能力矩阵、共享导航与验收报告。
- [x] 独立review，检查后本地提交，保留其他引擎和容器缺口。

- [x] 源码审查纠正ACP end_turn与rootcompleted不等价；修复结算时取消的复用竞态，限制错误/终态输出。
