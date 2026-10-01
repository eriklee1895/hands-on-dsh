# Hands-on DSH

通过构建应用、探索协议和阅读内部机制来学习 DeepSeek Harness（DSH）。

这个仓库服务于我的个人学习：从 Python SDK 的最小调用开始，逐步构建 FastAPI Web Agent，继续探索 ACP 与 TypeScript SDK，再学习 Cordis/plugin 和 TypeScript full-stack，最后进入 DSH 核心源码。

> Learn DSH by building agent applications, exploring protocols, and understanding its internals.

## 当前进度

当前已升级的 Python SDK、FastAPI 与可恢复服务固定 `0.1.5rc1`；TypeScript SDK、协议和存储实验固定 npm `0.1.7-rc.2`。Cordis 与 AG-UI 已迁移到同一 npm 版本，七篇机制笔记也按该 tag 审查；文章中没有重跑的执行链单独标明。先读[上游审查](docs/reviews/2026-09-28-upstream-refresh.md)与[工程化路线](docs/learning-paths/engineering.md)；最新结果见[第五批验收](docs/reviews/2026-09-29-plugin-agui-internals.md)，先前结果保留在各批记录中。

### ✅ Python SDK：由浅入深

[`tutorials/python-sdk/`](tutorials/python-sdk/README.zh.md)包含 6 个已实现并实测的示例：

1. `DeepSeekHarness.run()` 最小调用
2. runtime 进程与多轮 session 复用
3. 通知流中的 root 已提交消息投影（非逐 token streaming）
4. workspace 文件与工具调用
5. 底层 `HarnessClient` 生命周期
6. 手写 stdio JSON-RPC

每个示例都有独立教程和固定版本的源码说明。新版采用公开 profile、独立 home 与 workspace；工具结果由外部文件字节验证。逐例真实模型与 keyless 验收见 SDK 迁移记录。

### ✅ FastAPI 101：从零构建 Web Agent

[`tutorials/fastapi-101/`](tutorials/fastapi-101/README.md)是一套完整、可运行的中文入门课程：

- FastAPI lifespan 管理一个长期运行的 DSH runtime
- 同步 JSON API
- POST + SSE 状态、工具与已提交消息事件（非逐 token 输出）
- 浏览器多轮 session
- 工具调用、工具结果与 Agent 轨迹
- 同 session 串行、跨 session 并发
- runtime shutdown 与子进程回收
- 原生 HTML/CSS/JavaScript 前端

项目已迁移到 Python `0.1.5rc1` 的公开 profile/home 启动。真实 API、浏览器及 keyless 验收见[第三批记录](docs/reviews/2026-09-29-web-protocol-migration.md)；8 月记录保留为历史证据。

### ✅ Recoverable Agent Service：业务状态与断线恢复

[`projects/recoverable-agent-service/`](projects/recoverable-agent-service/README.md) 是一个没有浏览器 UI 的完整 FastAPI 服务：SQLite 持有 Conversation、Run、RunEvent 和 Artifact 权威状态；单 worker 驱动 DSH；命名 SSE 支持持久游标重放；执行不确定性需要显式确认并旋转 session；产物通过不可变 SQLite BLOB 下载。项目已升级到 Python `0.1.5rc1` 的公开 profile/home，新增正文使用已提交消息，旧 SQLite 事件原样重放；提供 Python 3.10 keyless 测试和显式真实 DSH E2E。

### ✅ SDK JSON-RPC 与 ACP 协议语义

[`labs/protocol-semantics/`](labs/protocol-semantics/README.md) 使用 npm `0.1.7-rc.2` 的公开 SDK/ACP profiles 与独立 Python JSONL peer，保留 keyless fake 和 exploratory command 模式。新版 ACP 提供 list/resume/close、模型配置、cancel 与 permission；SDK 仍以 committed SessionEvent 和 receipt-to-idle 为核心。真实 ACP 跨进程恢复、wire identity 与 release 的区分，以及关闭结果见[第三批验收](docs/reviews/2026-09-29-web-protocol-migration.md)。选型见[SDK JSON-RPC 与 ACP 对比](docs/comparisons/sdk-jsonrpc-vs-acp.md)。

### ✅ TypeScript SDK：通过公开 profile 管理 runtime

[`tutorials/typescript-sdk/`](tutorials/typescript-sdk/README.md) 提供四个渐进示例：启动同版本 npm dsh、高层 session 两轮复用、root committed-message/tool 投影，以及底层 `HarnessClient` receipt-to-idle。新版采用公开 `profile` / `dshHome` / `patches`，不再要求构建旧 source runtime；工具示例核对 34 字节产物。当前测试和真实运行结果见 [SDK 迁移记录](docs/reviews/2026-09-28-sdk-migration.md)。

Python/TypeScript 选型见 [Python SDK 与 TypeScript SDK](docs/comparisons/python-vs-typescript-sdk.md)。

### ✅ Cordis 与 DSH Plugin：原创生命周期与工具实验

[`labs/cordis-plugin-lifecycle/`](labs/cordis-plugin-lifecycle/README.md) 的原创 package 已升级到 `0.1.7-rc.2` / Cordis `4.0.4`：Service/inject、typed events/waterfall、effect cleanup、HMR/PENDING、proof tool 和 live/durable listener 保持可运行，新增 preset composition probe。稳定 `./tool`、`./listener` subpath 继续供毕业项目消费；26 个 keyless tests、packed consumer 与真实 27 字节 proof/audit 验证通过。

### ✅ AG-UI / CopilotKit Full-stack：业务权威状态与 Runtime 恢复

[`projects/ag-ui-dsh-runtime/`](projects/ag-ui-dsh-runtime/README.md) 通过公开 npm dsh profile/patch 启动 runtime，SQLite 持有业务 Conversation / Run / RunEvent / Artifact，React/CopilotKit 显示已提交消息、工具和持久 Run Inspector。V4 tool/result、package 模式和 generation lifecycle 已迁移。

跨 generation 恢复仍由项目的 deployment adapter 调用官方 `agents.resume()`，不是 stock SDK 的新增 RPC。当前两 Conversation、工具/产物、重启回读、detach/business cursor、桌面/375px UI 和 review 结果见[第五批验收](docs/reviews/2026-09-29-plugin-agui-internals.md)。

### ✅ How DSH Works：固定 revision 的核心机制追踪

[`how-dsh-works/`](how-dsh-works/README.md) 的七篇中文机制笔记已按 `0.1.7-rc.2` 完整 SHA 逐条审查，覆盖 profile/preset、Agent/loop、V4 tool/session、context/compaction、subagent/workflow-ptc 和 SDK/ACP/Web Host。3 个发布包 keyless probes 与以下新版 Lab 分别提供运行证据：

- Compaction：[真实 pressure、产物与持久重读](labs/compaction-lifecycle/README.md)、[受控溢出/取消](labs/compaction-lifecycle/RECOVERY.md)、[裁剪/offload 及图片 projection](labs/compaction-lifecycle/REDUCTION.md)。
- [附件输入](labs/attachment-input/README.md)：生产附件接纳/归一化、真实 Files 图片请求、历史复用与关闭后独立重读；[整请求fallback](labs/attachment-input/FALLBACK.md)验证受控Files失败后的真实inline传输。
- [Workflow/child](labs/workflow-child-lifecycle/README.md)：PTC 产物与正常关闭后的 child 冷恢复。
- 官方 Web：[实时帧、历史和重启续写](labs/web-host-lifecycle/README.md)、[审批、取消与离线控制](labs/web-host-lifecycle/CONTROLS.md)。

真实 provider 预算、stale Files ID恢复、复杂并行/retry 和崩溃恢复仍待补证。旧版603 tests 保存在独立历史页，不归入新版结果。

### ✅ Session V1 / V3 → V4：存储迁移实验

[`labs/session-format-migration/`](labs/session-format-migration/README.md) 通过真实发布版 persistence backend 与 worker，在 synthetic fixture 副本上验证只读逻辑迁移、写入 V4 successor、旧 generation 字节/hash 不变、重新打开稳定及 future/corrupt 拒绝。历史迁移覆盖 plaintext；默认 Zstd 只验证新建 V4 header。它不读取个人会话，也不等同于业务 Run 恢复。

## 学习路线图

路线按“先调用 runtime，再拥有业务恢复语义，随后理解协议、plugin、full-stack 与内部机制”的顺序推进：Python 集成 → recoverable service → SDK JSON-RPC / ACP → TypeScript SDK → Cordis/DSH plugin → AG-UI full-stack → fixed-revision internals。Phase 1–6 已有可运行产物和验收记录；Phase 7 已从单 runtime 生命周期实验开始，其余单元与旧课程迁移状态见工程化路线。

### Phase 1 — Python 集成基础

- [x] 使用 uv 管理 Python SDK 项目、依赖与 lockfile
- [x] 使用 Ruff 统一 lint 与格式检查
- [x] 安装 Python SDK 与匹配的 runtime wheel
- [x] 高层单轮与多轮调用
- [x] 通知投影与 root/child 事件过滤
- [x] workspace 工具任务
- [x] 底层 `HarnessClient`
- [x] 裸 JSON-RPC 对照实验
- [x] FastAPI + SSE + 浏览器 UI
- [x] SQLite 权威业务状态、可恢复 Run 与不可变 Artifact 服务

### Phase 2 — ACP

- [x] 理解 ACP 初始化、session、prompt、cancel 与 permission 语义
- [x] 新版 ACP 持久 session list/resume/close 与配置选择实验
- [x] 启动并手动驱动 DSH ACP server
- [x] 编写最小 ACP 客户端
- [x] 对比 SDK JSON-RPC 与 ACP 的能力和事件模型
- [x] 记录 DSH 当前 ACP 的能力边界与适用场景

### Phase 3 — TypeScript 调用 DSH

- [x] 安装并体验 `@deepseek-ai/dsh-sdk-client`
- [x] 管理 TypeScript 侧 profile/home/patch 与子进程生命周期
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
- [x] 历史官方七章学习；新版原创 lifecycle/preset 与 tool/listener 验证
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
- [x] 固定 `0.1.7-rc.2` 的公开 profile 与项目 adapter 跨 generation 恢复

### Phase 6 — DSH 内部机制与源码学习

- [x] Cordis plugin tree、effect 与 service 的源码追踪
- [x] `Agent`、inbox 与 agent loop
- [x] turn / step / tool 执行流水线
- [x] durable session event log、持久化与 projection
- [x] synthetic V1/V3 → V4 的只读/写入与不可变 predecessor 实验
- [x] compaction 与 context assembly
- [x] one-shot/continuable subagent 与 workflow
- [x] SDK JSON-RPC server/client 源码追踪
- [x] ACP server 源码追踪
- [x] Web Host RPC 与 DSH 官方 Web 客户端架构

### Phase 7 — 工程化专题

[详细顺序与验收条件](docs/learning-paths/engineering.md)；第一课见 [runtime-supervision](labs/runtime-supervision/README.md)。

- [x] 单 runtime supervisor：新版 profile、超时回收、关闭失败隔离与显式重建
- [x] [有界进程池](labs/runtime-supervision/POOL.md)：FIFO、排队取消、故障注入与真实双 runtime 验证
- [x] [身份认证与租户 API 数据访问](projects/recoverable-agent-service/TENANCY.md)：Bearer 验证、独立业务存储与跨租户拒绝
- [x] [本机 sandbox 探针](labs/sandbox-isolation/README.md)：真实文件写入、网络/进程观察与平台差异
- [ ] 容器化 workspace 与远程执行环境集成
- [x] [Run 观测与用量估算](labs/run-observability/README.md)：白名单元数据、重放去重与显式教学费率
- [x] [Eval 与可重放回归](projects/recoverable-agent-service/EVAL.md)：五类业务场景、负对照、独立真实成功路径
- [x] [DSH 双协议适配基础](labs/protocol-semantics/ADAPTERS.md)：显式能力、原生终态与共同场景
- [ ] Codex / Hermes 等其他引擎的适配与真实验收

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
pnpm install --frozen-lockfile
pnpm exec node --env-file=../../.env --import tsx examples/01_explicit_launch.ts
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

# 真实发布包模式需要本地 .env 与独立 state root，详见项目 README。
# 具体 node --env-file 启动命令见项目 README。
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

DSH 工具和 plugin 可能使用本地文件与进程权限。文件与命令示例只应针对可丢弃 workspace、容器或明确配置的 DSH sandbox 运行。TypeScript 教程固定使用的 minimal composition 是 `danger-full-access`；Cordis 真实 gate 即使移除 Bash/editor，custom plugin 与 runtime 仍拥有 host authority。disposable workspace 是任务目标目录，不是安全隔离边界。AG-UI 项目是无认证、单用户、loopback-only 的开发集成；其 resume adapter 是固定 `0.1.7-rc.2` 的项目部署适配器，不代表 stock DSH SDK JSON-RPC 已支持跨进程恢复。

本仓库不复制 DSH 核心源码。Python 教程使用已发布 SDK 与 bundled runtime；TypeScript 入门使用同版本 npm dsh 的公开 profile。full-stack 项目通过同版本公开 profile/patch 加载编译后的项目插件。机制学习通过固定 commit 链接到 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)。
