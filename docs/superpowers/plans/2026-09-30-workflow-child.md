# Workflow / child lifecycle 实施计划

Spec: [设计](../specs/2026-09-30-workflow-child-design.md)。基线 `a8c49a7`，继续现有 worktree；仅本地 commit，不 push。

1. [x] 固定源码与发行包核对；建立 Lab，锁定依赖。
2. [x] 先写失败测试，再实现公开 workflow/continuation service 的受控实验与证据验证；覆盖真实 PTC、取消/迟到 child、冷恢复/拒绝非父、证据负对照。
3. [x] 编译课程 plugin，通过两次独立 `sdk-minimal` launch 做真实产物与 child 冷恢复；关闭后重新读取持久日志，记录进程观察。
4. [x] 更新教程、机制章和路线；运行 Lab 测试/typecheck/lint/format/build/frozen install、相对链接/Mermaid/密钥检查，复核后 commit。

Review Focus: 第二阶段是否泄露口令、是否真正换进程、相同 child 与历史前缀、失败是否伪装成功、owner dispose 与 late-start cleanup、关闭失败保留目录。
