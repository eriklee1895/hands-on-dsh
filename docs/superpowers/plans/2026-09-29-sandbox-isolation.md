# Sandbox isolation implementation plan

> **For agentic workers:** Use dispatching-parallel-agents for worker/test and parent orchestration/docs; TDD and independent review required.

**Goal:** 完成7.4本机写入策略矩阵、真实shell工具与限制说明。

**Architecture:** 发布LocalSandboxProvider决定wrap；built worker只尝试自己fixture内操作；父进程核对状态和文件；真实SDK通过公开profile调用同worker。

**Tech Stack:** npmSDK0.1.7rc2、Cordis4.0.4、Node^22.19||>=24、pnpm12.3.4、Vitest、strictNodeNext。

**Spec:** [设计](../specs/2026-09-29-sandbox-isolation-design.md)。基线9761a68，现有worktree，本地commit授权继续，不push。

- [x] scaffold锁定工具链，独立worker与行为tests先RED后GREEN。
- [x] fixture/进程/外部效果验证，真实provider三模式matrix。
- [x] 两种受限mode真实SDK shell调用并检查durabletool事件和文件。
- [x] 中文README、平台能力表、导航与验收报告。
- [x] 独立review，相关测试/format/lint/build/安装/文档检查与本地commit。
