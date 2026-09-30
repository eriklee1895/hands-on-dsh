# Eval regression implementation plan

> **For agentic workers:** Use dispatching-parallel-agents for independent contract/grader and service scenario execution; TDD and independent review required.

**Goal:** 完成7.6确定性评测、反例验证、离线重评与独立真实模型证据。

**Architecture:** 固定dataset -> 真实应用+可控adapter/真实SDK -> 外部事实Observation -> 严格grader -> 可重放安全记录。

**Tech Stack:** 既有Python3.10、uv、pytest/Ruff、SDK0.1.5rc1，无新依赖。

**Spec:** [设计](../specs/2026-09-30-eval-regression-design.md)。原worktree，已授权本地commit，不push。

- [x] eval_contract.py与tests：strict dataset/Observation/grade/report，RED到GREEN。
- [x] eval_scenarios.py与tests：五场景真实应用执行，expected不可被runner读取。
- [x] 五案例fixture、CLI录制/重评/negative control，验证正确退出码。
- [x] 真实success模型1例与进程观察，scope独立报告。
- [x] 中文教程、导航、执行证据；review和适当检查后本地commit。

- [x] Review 补强：每例独立进程组 deadline、关闭后计数与seq复核、父子数据集指纹一致性。
