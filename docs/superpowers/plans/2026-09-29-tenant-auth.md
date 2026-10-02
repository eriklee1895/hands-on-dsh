# Tenant authentication implementation plan

> **For agentic workers:** Use dispatching-parallel-agents for independent implementation and teaching/configuration work; TDD and independent review required.

**Goal:** 完成 Phase7.3 的认证入口、双租户证据与中文教程。

**Architecture:** 静态摘要验证后路由到租户独立的既有服务；不改变业务schema与runtime生命周期。

**Tech Stack:** Python3.10、FastAPI/Starlette、uv、pytest/Ruff；SDK0.1.5rc1。

**Spec:** [设计](../specs/2026-09-29-tenant-auth-design.md)。基线b05fca9，原worktree继续，授权本地commit，不push。

## Task 1: Credential routing and access regression

- [x] tenancy.py与tests/test_tenancy.py：参数验证、统一401、selector拒绝、headers剥离、缓存策略、生命周期、跨租户read/write/recovery/SSE/artifact。
- [x] models.py ConversationCreate/RunCreate extra forbid，验证未知tenant/session字段不被接受。
- [x] RED/GREEN、相关既有回归和Python3.10检查。

## Task 2: Configuration, executable evidence, teaching

- [x] tenant_server.py与配置测试：环境解析、路径、显式factory启动。
- [x] examples/tenant_probe.py：真实环回HTTP，可控runtime默认；--real使用真实DSH，token内存生成不输出。
- [x] TENANCY.md、README、共享导航、review报告；清楚区分HTTP隔离与执行隔离。
- [x] 独立review、测试/格式/链接/敏感信息检查后本地commit。
