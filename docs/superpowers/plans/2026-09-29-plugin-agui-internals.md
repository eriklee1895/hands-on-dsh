# Plugin、AG-UI 与机制笔记执行计划

> **For agentic workers:** Use dispatching-parallel-agents for separate directories after agreeing the existing plugin subpath interface. Consumers wait for producer build before integration. Apply TDD, independent review and browser verification.

**Goal:** 剩余旧版项目与机制文章按固定 `0.1.7-rc.2` 迁移，验证范围可追溯。

**Architecture:** Cordis lab 提供稳定 tool/listener；AG-UI 通过公开 SDK profile 加载部署适配器；机制文章以固定源码及明确范围的 probes 为依据。

**Tech Stack:** Node ^22.19.0 || >=24、TypeScript strict/NodeNext、pnpm、Vitest、Cordis、Fastify、React/CopilotKit。

**Spec:** [设计](../specs/2026-09-29-plugin-agui-internals-design.md)

## Global Constraints

- DSH `0.1.7-rc.2`、Cordis `4.0.4`，不要追逐 master 或升级无关 React/AG-UI 依赖。
- 不修改 upstream、个人 session 或既有用户 DB；保留历史事件。
- public profile/patch 启动；不使用旧私有 launcher。
- 不冒称 token streaming、SDK 原生 resume、模型输出即 artifact 或旧 tests 即新版验证。
- 子任务不 stage/commit/push，协调者整体验证后本地提交，不推送。

## Review Focus

- Tool/result V4 字段、call ID、live/durable 顺序及 effect 注册撤销。
- generation 退出未确认、持久 home 与临时配置清理、跨进程 resume cwd/identity。
- 完整 committed text 不重复，raw 与 projected cursor 恢复不把旧消息当新 Run。
- 旧业务数据库可读，客户端不得绕过后端产物/业务状态验证。
- 笔记事实逐条对应固定 revision，历史证据不扩大为新版本验证。

### Task 1: Cordis / Preset

**Files:** `labs/cordis-plugin-lifecycle/`。

**Interfaces:** package 名称及 `./tool`、`./listener`，tool/config/proof/audit/health 协议保持；仅适应 DSH 新版运行接口。

- [x] RED/GREEN 升依赖与 Agent/tool/listener API；公开 profile/patch。
- [x] 最小 preset composition 说明与执行验证。
- [x] tests/build/typecheck/lint/format/pack smoke；真实工具、字节/audit/进程观察。

### Task 2: AG-UI Runtime

**Files:** `projects/ag-ui-dsh-runtime/`。

**Interfaces:** Task 1 的 subpaths；业务 HTTP/SQLite 语义保留；package 模式替换 source 模式；新 V4 committed-message/tool projector。

- [x] 审查并迁移公开 package launcher/patch、resume adapter 和 V4 投影。
- [x] 同步 fake fixtures、调用方、CLI、README；去掉失效 source attestation。
- [x] 使用 Task 1 的新版 build 联调，server/web tests、typecheck、build、foreign-cwd smoke。
- [x] 真实双 Conversation/tool/artifact、generation 重启与记忆、detach/business replay、进程回收。

### Task 3: Core Notes

**Files:** `how-dsh-works/`。

**Interfaces:** 固定源码引用和逐篇 probe/evidence 表；与已验证 lab 相互链接，不复制实现。

- [x] 七篇逐条 source audit/update，标明版本与当前/历史证据。
- [x] 执行可行的最小新版 keyless probes，记录精确范围；未执行项目明确列出。
- [x] 链接/Mermaid/术语检查，不借 master 或旧结果充数。

### Task 4: 整合

**Files:** README、projects/labs/learning-paths、`docs/reviews/2026-09-29-plugin-agui-internals.md`。

- [x] 独立 review producer、consumer 与 source notes，修复重要问题。
- [x] 桌面与375px浏览器、console/错误/恢复，严格区分 real/fake 验证。
- [x] 最终导航/版本/链接/凭据检查，记录局限并提交本地 commit。
