# FastAPI 与协议实验执行计划

> **For agentic workers:** Use dispatching-parallel-agents for the independent directories, TDD for changed behavior, then independent code review and browser verification.

**Goal:** 新版 FastAPI 与 SDK/ACP 实验可执行，输出和能力说明符合固定发行版。

**Architecture:** Python `0.1.5rc1` 运行 Web 教程，npm `0.1.7-rc.2` 的公开 dsh profiles 运行 wire lab；共享文档记录两个版本。

**Tech Stack:** Python >=3.10、uv/pytest/Ruff、FastAPI、原生 JS、Node/pnpm、JSONL/SSE。

**Spec:** [设计](../specs/2026-09-29-web-protocol-migration-design.md)

## Global Constraints

- 保留现有 worktree；前两批 checkpoint `124802b`。
- FastAPI Python `0.1.5rc1`；protocol DSH `0.1.7-rc.2` / ACP SDK `1.4.0`。
- 不使用旧私有 package bin，不伪造逐 token 输出，不把 fake 等同真实恢复。
- 子任务不修改共享文档或彼此目录，不 stage/commit/push。

## Review Focus

- 后续/child/foreign 消息不覆盖 root 回答；final 不重复 append。
- shutdown 期间拒绝新请求；JSON 与 SSE 已接纳任务均纳入关闭等待。
- failure 初始化、disconnect、queue saturation、模型 error 都可正确结束并保留解释。
- package resolver 不受 cwd 或环境重定向；wire identity 不能作为安装版本证据。
- ACP resume 校验 inactive/cwd，list 排除 active，历史消息不被当作新 update。

### Task 1: FastAPI 101

**Files:** `tutorials/fastapi-101/`。

**Interfaces:** `BrowserEvent.assistant_message` 的 text 为已提交 root 文本；JSON RunOutput 保留字段，failure 明确表达。显式 runtime home 的配置由 README 拥有。

- [x] 写失败回归；升级精确依赖与 profile/home 启动。
- [x] 更新 event projection、JS 呈现、五章文档和生命周期。
- [x] pytest/Ruff/Python3.10；真实 JSON/SSE/memory/tool-byte/关闭验证。

### Task 2: Protocol Semantics

**Files:** `labs/protocol-semantics/`。

**Interfaces:** fake/package/command 启动；package 输出安装版本、profile 与 closeOutcome；SDK committed answer；ACP session lifecycle 与 config capabilities。

- [x] 锁定 npm runtime/ACP版本，验证公开 CLI resolver；移除 source-demo launch。
- [x] 更新 fake servers/probes/transcripts/测试和文档；保留关键 JSONL、cancel、permission 覆盖。
- [x] keyless/工具检查；真实 SDK/ACP prompt 与持久恢复，外部进程回收。

### Task 3: 浏览器、能力对照与验收

**Files:** root README、两条 learning path、`docs/comparisons/sdk-jsonrpc-vs-acp.md`、`docs/reviews/2026-09-29-web-protocol-migration.md`。

- [x] 浏览器验证 FastAPI 桌面与窄屏、SSE 已提交回复、工具轨迹、错误与 console。
- [x] 固定源码核对 ACP list/resume/close/config，重写选型矩阵。
- [x] 独立 review 并修复重要问题；链接/图/格式检查，记录精确结果与未覆盖范围。
