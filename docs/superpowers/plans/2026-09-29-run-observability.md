# Run observability implementation plan

> **For agentic workers:** Use dispatching-parallel-agents for core projection/ledger tests and separate persistence/examples/docs. TDD and independent review required.

**Goal:** 完成7.5可运行观测记录、重放去重和可解释用量估算。

**Architecture:** SDK事件白名单投影 -> 规范化账本 -> 单进程快照重载 -> 显式教学费率估算；业务事实与invoice分开。

**Tech Stack:** npmSDK0.1.7rc2、Node^22.19||>=24、pnpm12.3.4、TypeScript strict、Vitest；无新增SaaS。

**Spec:** [设计](../specs/2026-09-29-run-observability-design.md)。基线4cc945b，原worktree继续，本地commit，不push。

- [x] 核对固定源码usage/attempt/retry语义，设计projection与ledger类型。
- [x] core.ts与tests/core.test.ts先RED后GREEN，覆盖重复/冲突/未知usage/敏感payload/算术。
- [x] snapshot.ts持久快照与重载测试，keyless replay及真实双run示例。
- [x] 中文README、图、版本事实/运行证据、导航状态。
- [x] 独立review和适当检查后本地提交。
