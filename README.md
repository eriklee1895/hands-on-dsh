# Hands-on DSH

通过构建应用、探索协议和阅读内部机制来学习 DeepSeek Harness（DSH）。

这个仓库服务于我的个人学习：从 Python SDK 的最小调用开始，逐步构建 FastAPI Web Agent，继续探索 ACP 与 TypeScript SDK，再学习 Cordis/plugin 和 TypeScript full-stack，最后进入 DSH 核心源码。

> Learn DSH by building agent applications, exploring protocols, and understanding its internals.

## 当前进度

### ✅ Python SDK：由浅入深

[`tutorials/python-sdk/`](tutorials/python-sdk/README.zh.md)包含 6 个已实现并实测的示例：

1. `DeepSeekHarness.run()` 最小调用
2. runtime 进程与多轮 session 复用
3. `assistant/chunk` 流式文本输出
4. workspace 文件与工具调用
5. 底层 `HarnessClient` 生命周期
6. 手写 stdio JSON-RPC

每个示例都有独立教程、源码说明和 Mermaid 流程图。示例已经使用真实 DeepSeek API 验证。

### ✅ FastAPI 101：从零构建 Web Agent

[`tutorials/fastapi-101/`](tutorials/fastapi-101/README.md)是一套完整、可运行的中文入门课程：

- FastAPI lifespan 管理一个长期运行的 DSH runtime
- 同步 JSON API
- POST + SSE 流式事件
- 浏览器多轮 session
- 工具调用、工具结果与 Agent 轨迹
- 同 session 串行、跨 session 并发
- runtime shutdown 与子进程回收
- 原生 HTML/CSS/JavaScript 前端

项目提交 keyless 单元测试、Mermaid 图和架构插图；新近完成的手动真实模型与浏览器验证记录在 [阶段 0 验收记录](docs/learning-paths/python-app-builder.md#阶段-0-验收记录-2026-08-31)。

### ✅ Recoverable Agent Service：业务状态与断线恢复

[`projects/recoverable-agent-service/`](projects/recoverable-agent-service/README.md) 是一个没有浏览器 UI 的完整 FastAPI 服务：SQLite 持有 Conversation、Run、RunEvent 和 Artifact 权威状态；单 worker 驱动 DSH；命名 SSE 支持持久游标重放；执行不确定性需要显式确认并旋转 session；产物通过不可变 SQLite BLOB 下载。项目提供 Python 3.10 keyless 测试和显式真实 DSH E2E。

### ✅ SDK JSON-RPC 与 ACP 协议语义

[`labs/protocol-semantics/`](labs/protocol-semantics/README.md) 提供两个独立 wire lab：共享 JSONL peer、确定性 fake servers、SDK receipt-to-idle、ACP committed output/cancel/permission、错误与 typed close outcome。实验固定 DSH `0.1.1-rc.2` source revision，已通过 upstream keyless suites 和 review 后各一次真实 source prompt；SDK shutdown/exit 无 escalation，ACP 当次 EOF exit 0，两个 owned process group 均消失。选型见 [SDK JSON-RPC 与 ACP 对比](docs/comparisons/sdk-jsonrpc-vs-acp.md)。

### ✅ TypeScript SDK：显式管理 source runtime

[`tutorials/typescript-sdk/`](tutorials/typescript-sdk/README.md) 提供四个已实现并实测的示例：显式启动固定 rc.2 runtime、高层 session 两轮复用、root notification/tool 投影，以及底层 `HarnessClient` receipt-to-idle。项目锁定 Node/pnpm/TypeScript/Vitest/Oxlint/Oxfmt，提交 48 个 keyless 测试，并完成四个真实模型 gate。tool 示例的 34 字节产物由外部监视器在 cleanup 前核对；每次正常退出后匹配的 runtime 和观察到的 descendant 均从进程表消失。

Python/TypeScript 选型见 [Python SDK 与 TypeScript SDK](docs/comparisons/python-vs-typescript-sdk.md)。

### ✅ Cordis 与 DSH Plugin：原创生命周期与工具实验

[`labs/cordis-plugin-lifecycle/`](labs/cordis-plugin-lifecycle/README.md) 完整实跑官方七章但不复制其源码，并实现原创 proof journal package：Service/inject/reactivation、typed events/waterfall、ordered effect cleanup、stable-ID HMR/PENDING、`write_stage4_proof` tool 和 live/durable listener。package 暴露稳定 `./tool`、`./listener` subpath，当前 25 个 keyless tests、plain-Node packed consumer 和 authoritative 真实 DeepSeek tool call 均已通过；root tool call、独立 live observer 和 durable result 均恰好一次且 call ID/content 一致，外部核对 27 字节 artifact、audit、idle 与正常进程退出。

### ✅ AG-UI / CopilotKit Full-stack：业务权威状态与 Runtime 恢复

[`projects/ag-ui-dsh-runtime/`](projects/ag-ui-dsh-runtime/README.md) 是 TypeScript full-stack 毕业项目：Fastify 显式拥有 DSH source runtime，SQLite 持有 Conversation / Run / RunEvent / Artifact，React + CopilotKit 通过 AG-UI 显示对话、工具和持久 Run Inspector。项目提交 117 个 keyless tests，并通过 production build、foreign-cwd adapter smoke、桌面/375px 浏览器与 Axe 零违规验收。

真实 rc.2 gate 发现 stock SDK JSON-RPC server 不会跨进程 resume 已有 JSONL session。项目保留 upstream clean，以 generation-local deployment adapter 复用官方 server 并把持久 identity 路由到官方 `agents.resume()`。最终两个 Conversation、四个真实 Run 均得到恰好一次 tool/result 与 exact Artifact；runtime generation 1→2 后同一 DSH session 的 JSONL turn 连续为 `[1,2,3]`，模型准确回忆 `ONYX-842`；AG-UI fetch 分离后 business cursor 仍到达 terminal，最终 server/runtime 与 generation 目录全部回收。

### ✅ How DSH Works：固定 revision 的核心机制追踪

[`how-dsh-works/`](how-dsh-works/README.md) 提供 7 篇按调用链排列的中文机制笔记：plugin tree/runtime 组装、Agent Inbox/AgentLoop、Turn/Step/tool pipeline、SessionEvent persistence/projection、compaction/context assembly、subagent/workflow，以及 SDK JSON-RPC/ACP/Web Host。全部固定到 `dsh-v0.1.1-rc.2` 的完整 commit，区分源码事实、运行观察、推断、建议和未确认边界；每篇包含一个经过 Mermaid parser 验证的图与实际运行的 keyless focused probe，交付前 combined regression 覆盖 21 个 upstream test files / 603 tests。

## 学习路线图

路线按“先调用 runtime，再拥有业务恢复语义，随后理解协议、plugin、full-stack 与内部机制”的顺序推进：Python 集成 → recoverable service → SDK JSON-RPC / ACP → TypeScript SDK → Cordis/DSH plugin → AG-UI full-stack → fixed-revision internals。Phase 1–6 已有可运行产物和验收记录；Phase 7 保持未完成，只表示下一阶段的工程化学习方向。

### Phase 1 — Python 集成基础

- [x] 使用 uv 管理 Python SDK 项目、依赖与 lockfile
- [x] 使用 Ruff 统一 lint 与格式检查
- [x] 安装 Python SDK 与匹配的 runtime wheel
- [x] 高层单轮与多轮调用
- [x] 流式通知和事件过滤
- [x] workspace 工具任务
- [x] 底层 `HarnessClient`
- [x] 裸 JSON-RPC 对照实验
- [x] FastAPI + SSE + 浏览器 UI
- [x] SQLite 权威业务状态、可恢复 Run 与不可变 Artifact 服务

### Phase 2 — ACP

- [x] 理解 ACP 初始化、session、prompt、cancel 与 permission 语义
- [x] 启动并手动驱动 DSH ACP server
- [x] 编写最小 ACP 客户端
- [x] 对比 SDK JSON-RPC 与 ACP 的能力和事件模型
- [x] 记录 DSH 当前 ACP 的能力边界与适用场景

### Phase 3 — TypeScript 调用 DSH

- [x] 安装并体验 `@deepseek-ai/dsh-sdk-client`
- [x] 管理 TypeScript 侧 runtime 命令与子进程生命周期
- [x] 使用高层 `DeepSeekHarness` 与底层 `HarnessClient`
- [x] 处理 notification stream、session 与 subagent 事件
- [x] 用一个协议 parity smoke 对齐 Python JSON-RPC lab，不重复实现 raw transport
- [x] 对比 Python 与 TypeScript SDK 的开发体验和能力差异

### Phase 4 — Cordis 与 DSH Plugin Development

- [x] 理解 Cordis `Context`、plugin tree、`Service`、`inject` 与 effect
- [x] 掌握 `emit`、`waterfall`、`parallel`、`serial` 事件模式及 listener 组合
- [x] 从最小 `apply(ctx)` plugin 开始，验证安装、配置、reload 与 teardown
- [x] 通过 `cordis.yml` 组合 plugin，理解 profile、bundle 与运行时配置
- [x] 扩展一个 DSH tool 和 result/session listener，并正确清理注册资源
- [x] 阅读并实跑官方七章及目标 subsystem reference
- [x] 完成自定义 DSH plugin 的 keyless、packed consumer 与真实模型端到端实验

### Phase 5 — TypeScript full-stack Agent 应用

- [x] TypeScript BFF 管理 DSH runtime 与 generation
- [x] React + CopilotKit/AG-UI Agent UI
- [x] AG-UI SSE 与独立 business cursor SSE
- [x] 多 session、工具轨迹与 raw/projected 事件展示
- [x] 应用自己的 Conversation / Run / RunEvent / Artifact 状态模型
- [x] 断线恢复、背压、错误、execution-unknown 与优雅关闭
- [x] 记录 loopback、danger-full-access、认证和多租户边界
- [x] 通过 tracked `file:` dependency 消费 Cordis lab 的 `./tool` 与 `./listener`
- [x] 固定 rc.2 进程重启后通过项目 adapter 恢复持久 DSH session

### Phase 6 — DSH 内部机制与源码学习

- [x] Cordis plugin tree、effect 与 service 的源码追踪
- [x] `Agent`、inbox 与 agent loop
- [x] turn / step / tool 执行流水线
- [x] durable session event log、持久化与 projection
- [x] compaction 与 context assembly
- [x] one-shot/continuable subagent 与 workflow
- [x] SDK JSON-RPC server/client 源码追踪
- [x] ACP server 源码追踪
- [x] Web Host RPC 与 DSH 官方 Web 客户端架构

### Phase 7 — 工程化专题

- [ ] runtime supervisor 与进程池
- [ ] 认证与多租户隔离
- [ ] sandbox、容器化 workspace 与远程执行隔离
- [ ] 可观测性、token 用量与审计
- [ ] eval、回放与 keyless 测试
- [ ] 协议适配层：DSH / ACP / Codex / Hermes

## 仓库结构

```text
hands-on-dsh/
├── tutorials/                  # 跟着章节系统学习
│   ├── python-sdk/
│   ├── fastapi-101/
│   └── typescript-sdk/
├── projects/                   # 用完整项目巩固知识
├── labs/                       # 针对单一问题做实验
│   ├── protocol-semantics/
│   └── cordis-plugin-lifecycle/
├── how-dsh-works/              # 理解 DSH 如何工作
└── docs/                       # 跨主题学习资料
    ├── learning-paths/
    └── comparisons/
```

目录按自学活动而不是单一技术分类。跨主题内容由 `docs/learning-paths/` 串联，避免在多个目录复制代码。

## 快速开始

### Python SDK

```sh
uv sync --project tutorials/python-sdk --group dev
uv run --project tutorials/python-sdk --env-file .env python tutorials/python-sdk/01_hello.py
```

### FastAPI 101

```sh
cd tutorials/fastapi-101
uv sync --group dev
uv run --env-file ../../.env python -m dsh_fastapi_101
```

然后访问 `http://127.0.0.1:8000/chapter/1`。

### Recoverable Agent Service

```sh
cd projects/recoverable-agent-service
uv sync --group dev
uv run --env-file ../../.env python -m recoverable_agent_service
```

### Protocol Semantics Labs

```sh
cd labs/protocol-semantics
uv sync --group dev
uv run python -m protocol_labs.sdk_jsonrpc --server fake
uv run python -m protocol_labs.acp --server fake
```

### TypeScript SDK

```sh
cd tutorials/typescript-sdk
corepack pnpm install --frozen-lockfile
DSH_SOURCE_ROOT=/absolute/path/to/disposable-deepseek-harness \
  node --env-file=../../.env --import tsx examples/01_explicit_launch.ts
```

### Cordis Plugin Lifecycle

```sh
cd labs/cordis-plugin-lifecycle
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm build
corepack pnpm pack:smoke
```

### AG-UI DSH Runtime

```sh
cd projects/ag-ui-dsh-runtime
corepack pnpm install --frozen-lockfile
corepack pnpm build

# keyless：分别在两个终端运行
corepack pnpm server:fake
corepack pnpm dev:web

# 真实 source runtime 先对 disposable rc.2 checkout 生成 attestation，
# 再通过显式 --runtime source / --source-root 启动；详见项目 README。
```

## 验证

```sh
uv run --project tutorials/python-sdk pytest tutorials/python-sdk/tests
uv run --project tutorials/python-sdk ruff check tutorials/python-sdk
uv run --project tutorials/python-sdk ruff format --check tutorials/python-sdk
uv run --project tutorials/fastapi-101 pytest -c tutorials/fastapi-101/pyproject.toml tutorials/fastapi-101/tests
uv run --project tutorials/fastapi-101 ruff check tutorials/fastapi-101
uv run --project tutorials/fastapi-101 ruff format --check tutorials/fastapi-101
uv run --project projects/recoverable-agent-service pytest -c projects/recoverable-agent-service/pyproject.toml projects/recoverable-agent-service/tests
uv run --project projects/recoverable-agent-service ruff check projects/recoverable-agent-service
uv run --project projects/recoverable-agent-service ruff format --check projects/recoverable-agent-service
uv run --python 3.10 --project labs/protocol-semantics pytest labs/protocol-semantics/tests
uv run --python 3.10 --project labs/protocol-semantics ruff check labs/protocol-semantics
uv run --python 3.10 --project labs/protocol-semantics ruff format --check labs/protocol-semantics
cd tutorials/typescript-sdk
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
cd ../../labs/cordis-plugin-lifecycle
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm build
corepack pnpm pack:smoke
cd ../../projects/ag-ui-dsh-runtime
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm build
corepack pnpm smoke:server
```

## 学习原则

- 先运行，再阅读源码
- 用真实外部状态验证 Agent 工作，不只相信模型回复
- 区分业务 Task / Run 与 runtime session
- 区分高层 SDK、底层客户端和协议本身
- 每个主题都保留可运行 demo、完整教程和验证命令
- 凭据只放环境变量，不写入代码、文档或 Git

## 安全说明

DSH 工具和 plugin 可能使用本地文件与进程权限。文件与命令示例只应针对可丢弃 workspace、容器或明确配置的 DSH sandbox 运行。TypeScript 教程固定使用的 minimal composition 是 `danger-full-access`；Cordis 真实 gate 即使移除 Bash/editor，custom plugin 与 runtime 仍拥有 host authority。disposable workspace 是任务目标目录，不是安全隔离边界。AG-UI 项目是无认证、单用户、loopback-only 的开发集成；其 resume adapter 是固定 rc.2 的项目部署补丁，不代表 stock DSH SDK JSON-RPC 已支持跨进程恢复。

本仓库不复制 DSH 核心源码。Python 教程使用已发布 SDK 与 bundled runtime；TypeScript 教程和 full-stack 项目使用已发布客户端/package，并显式启动固定 revision 的 source runtime。机制学习通过固定 commit 链接到 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)。
