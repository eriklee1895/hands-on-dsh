# Learning Paths

学习路径回答“为了达到某个目标，应该按什么顺序学习”。路径可以跨越 `tutorials/`、`labs/`、`projects/` 和 `how-dsh-works/`。

## 当前路径

- [Python App Builder](python-app-builder.md)：Python SDK → FastAPI Web Agent。
- [TypeScript Runtime Builder](typescript-runtime-builder.md)：协议语义 → TypeScript SDK → Cordis/plugin → full-stack。
- [DSH Internals Reader](../../how-dsh-works/README.md)：固定 rc.2 revision，从 plugin tree → AgentLoop → Session/compaction → subagent/workflow → 外部协议。

三条路径都已经有可运行产物和验证记录。工程化路线已覆盖runtime supervisor、认证/多租户、本机sandbox、可观测性、eval/replay与DSH双协议adapter；容器、跨引擎及恢复扩展继续逐项验收。

- [工程化路线](engineering.md)：版本迁移与 Phase 7 的逐课产物、依赖和验收。
