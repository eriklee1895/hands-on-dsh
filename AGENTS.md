# AGENTS.md

本文件为参与 `hands-on-dsh` 的 AI coding agent 提供最小、稳定的项目上下文。开始任务时先读本文件，再读取目标目录的 README 和与任务直接相关的教程或源码说明。

## First: What Is DSH?

DeepSeek Harness（`dsh`）是 DeepSeek AI 开源的 agent harness。它基于 Cordis，采用 **everything-is-a-plugin** 架构：模型适配器、工具注册、会话日志、agent loop、权限、Web UI 等能力都通过 plugin 组合。

DSH 不是一个模型，不只是 Web UI，也不等于某个 Python 或 TypeScript SDK。它是承载 Agent 执行的可组合 runtime：接收输入，维护 session 和事件日志，组装模型请求，执行工具，并通过不同客户端或协议向业务应用暴露能力。

使用 DSH 时保持这个心智模型：

```text
Business Application
  -> SDK / JSON-RPC / ACP / protocol adapter
  -> DSH runtime process
  -> Agent handle + AgentLoop driver + Session + Cordis plugin tree
  -> Model / Tools / Workspace
```

运行中的 DSH 是一棵按配置组装的 plugin tree，不是一个需要不断修改的特权内核。扩展 DSH 时优先组合或开发 plugin；研究行为时先确认实际加载的 profile、bundle 和配置。

### Cordis mental model

[Cordis](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer) 是 DSH 底层以 vendor 方式引入的 plugin framework。开发或分析 DSH plugin 前先理解这些规则：

- plugin 是由 Cordis 管理生命周期的 function、object 或 `Service` class，通过 `apply(ctx)` 挂载；
- `Context` 是 service 容器，能力通过稳定的 `ctx.<key>` 获取，而不是依赖具体实现；
- plugin 通过 `inject` 声明 service 依赖，Cordis 等依赖就绪后再启动 plugin；
- 类型化事件按 `emit`、`waterfall`、`parallel` 或 `serial` 约定分发；
- tool、listener、provider 和其他注册都是可逆 effect，必须由 `ctx.effect()`、`ctx.on()` 或注册 API 的 disposer 在 reload/teardown 时撤销。

Cordis waterfall 是环绕中间件。仅观察、修改后继续委托或包装下游结果的 listener 必须调用 `next()`；不调用 `next()` 会短路后续 listener，只能用于明确拥有最终决策权的策略。

新增或修改 DSH plugin 时，先读 [Cordis Primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer) 和 [Plugin Development](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)，再查目标 subsystem 的 service/event reference。

DSH 目前处于 developer preview，可能发生兼容性破坏变更。任何关于当前 API、协议、默认值和能力的陈述都必须按实际版本查证。

## Repository Identity

`hands-on-dsh` 是 Erik 的个人 DeepSeek Harness 学习仓库，不是 DSH 官方文档、fork、发行版或兼容实现。

仓库目标是通过以下方式学习如何使用 DSH 构建自己的 Agent 项目：

- 编写可以直接运行的多语言客户端和完整 Agent 应用；
- 实验 DSH 支持的客户端协议、事件模型和适配方式；
- 阅读官方源码并理解 DSH 的架构和运行机制；
- 为每个结论保留验证命令、测试和版本上下文。

顶层 [README](README.md) 拥有当前完成状态和未来学习路线。本文件只保存 Agent 高频需要的行为规则和内容路由。

## Core Terminology

- **DSH**：DeepSeek Harness 项目及其发布的 runtime、SDK 和协议实现。
- **Upstream**：DSH 官方 GitHub 仓库、官方文档和官方发行包。
- **Runtime**：实际运行 Agent、持有 session 并产生事件的 DSH 进程。
- **Cordis**：DSH 底层的 plugin framework，负责 context、service、事件、依赖和可逆生命周期。
- **Context**：具备作用域和生命周期的 service 容器，也是 plugin 注册 effect 和 event listener 的入口。
- **Service**：占据稳定 `ctx.<key>` 的能力接口；consumer 依赖 service，不依赖具体 provider。
- **Effect**：随 plugin 安装并在 reload/teardown 时撤销的注册或资源所有权。
- **Agent**：面向调用方的实时 handle，暴露 session、inbox、status、作用域和运行控制，不规定具体 loop 实现。
- **AgentLoop**：可替换的 Agent driver，负责领取输入、组装模型请求、推进 step/turn 和工具执行。
- **Session**：拥有持久事件日志和对话状态的 DSH 标识。
- **Turn**：Agent 从领取输入到不再欠下工作的完整轮次。
- **Step**：一次模型请求及其产生的工具调用。
- **Plugin**：向 Cordis context 注册服务、事件、工具或其他能力的组合单元。
- **SDK JSON-RPC**：DSH SDK 使用的 JSON-RPC 客户端/服务器协议，默认可通过 stdio 承载。
- **ACP**：面向 Agent 客户端互操作的协议；它与 SDK JSON-RPC 不是同一接口。
- **AG-UI**：面向用户界面的 Agent 事件协议，可承载消息、状态、工具和生命周期事件。

业务 Task / Run 不等于 DSH Session / Turn。需要持久任务编排、崩溃恢复、产物或授权的生产应用应拥有自己的业务状态；DSH session ID 是 runtime 引用，不能作为权威业务任务状态。小型学习 demo 不必预先引入所有业务 aggregate。

## Repository Layout

- `tutorials/`：有明确起点、章节顺序和完成结果的系统教程。
- `projects/`：可以作为完整应用运行和演示的学习成果。
- `labs/`：针对一个具体机制的最小实验。
- `how-dsh-works/`：DSH 架构、源码路径和运行机制学习。
- `docs/learning-paths/`：按学习目标串联不同目录。
- `docs/comparisons/`：比较 SDK、协议、语言和架构选择。

归属由主要学习目标决定，而不是由出现了哪些技术决定：

- 目标是“一步步学会”时放入 `tutorials/`；
- 目标是“完成一个端到端应用”时放入 `projects/`；
- 目标是“验证一个问题”时放入 `labs/`；
- 目标是“解释 DSH 为什么这样工作”时放入 `how-dsh-works/`；
- 跨主题顺序放入 `docs/learning-paths/`。

一个事实或实现只有一个 canonical home。跨主题内容使用相对链接，不复制代码或长篇解释。不要提前创建没有内容的技术目录。

## Owner Preferences

### Learning style

- 先运行最小示例，再阅读源码。
- 用真实外部状态验证 Agent 工作，不只相信模型回复。
- 把高层 SDK、底层客户端、传输和服务器协议分开理解。
- 先做小而明确的实验；验证有复用价值后再抽象。
- 复杂时序、层级、状态或映射优先使用 Mermaid。
- 生成插图只用于帮助理解，不作为精确协议或 API 真源。

### Python

- Python 项目统一使用 uv、`pyproject.toml` 和 `uv.lock`。
- 依赖操作使用 `uv add`、`uv remove`、`uv sync` 和 `uv lock`。
- 执行项目命令使用 `uv run`；不要在教程中使用 pip、Poetry 或手工 venv 流程。
- Python 使用 Ruff lint 和 format，测试使用 pytest。
- 当前 Python SDK 教程支持 Python 3.10 及以上；测试代码也必须满足该下限。
- 普通脚本通过 `uv run python script.py` 启动，不保留无实际用途的 shebang。

### Documentation

- 中文优先；英文对照按学习价值决定，不要求所有内容双语。
- 文档陈述当前事实，不把计划写成已实现能力。
- 教程命令必须从其声明的工作目录实际可运行。
- 使用相对仓库路径；不要写个人机器的绝对路径。
- README 的完成状态必须与当前文件、测试和实际运行证据一致。

### TypeScript

TypeScript 子项目建立时，在子项目内确定并锁定 Node 版本、package manager、lint、format 和测试工具。不要提前在根目录引入未使用的 TypeScript 工具链。

不得假设 TypeScript SDK 与 Python SDK 功能对等。先检查实际发行包、runtime 启动要求、协议类型和官方源码，再编写教程或比较结论。

## Upstream Sources

按问题使用以下官方真源：

| 任务 | 官方资料 |
| --- | --- |
| 项目源码、版本、issue、release | [DeepSeek Harness GitHub](https://github.com/deepseek-ai/deepseek-harness) |
| Web UI、模型配置、workspace 和首次任务 | [Quickstart](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) |
| Python SDK、runtime、session 和程序化调用 | [Python SDK](https://deepseek-harness.github.io/deepseek-harness/guide/python-sdk) |
| Cordis context、service、事件模式和可逆 effect | [Cordis Primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer) |
| `apply`、Cordis context、effect 和 plugin 依赖 | [Plugin Development](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) |
| Cordis、plugin tree、事件、turn/step 和完整架构 | [Reference](https://deepseek-harness.github.io/deepseek-harness/reference/) |

事实查证优先级：

1. 本仓库锁定的 SDK/runtime 版本和实际运行结果；
2. 对应 tag 或 commit 的 DSH 官方源码；
3. DSH 官方文档；
4. issue、discussion 和第三方资料。

官方文档中的 pip 示例可以转换为本仓库的 uv 工作流，但不能改变 API、生命周期、安全或协议语义。

修改或研究 DSH 官方源码时，先阅读 upstream 自己的 `AGENTS.md`。不要把 upstream 的贡献规范复制成这个个人学习仓库的规则。

## How to Investigate DSH Internals

需要理解 DSH 内部机制时，不要只搜索本仓库，也不要仅凭 SDK 包装层推断 runtime 行为。使用一个 DSH upstream checkout，并按以下顺序调查：

1. 从本仓库的 `pyproject.toml`、`uv.lock` 或 `package.json` 确认实际使用的 SDK/runtime 版本；
2. 将发行版本解析到对应 upstream tag/commit，例如 PEP 440 的 `0.1.1rc1` 对应 `dsh-v0.1.1-rc.1`；
3. 使用 `git tag --list 'dsh-v*'` 和 `git rev-parse '<tag>^{commit}'` 验证 revision，并通过 `git show` 或独立 worktree 阅读该 revision；
4. 记录实际调查 revision 的 `git describe --tags --always` 与 `git rev-parse HEAD`；
5. 先读该 revision 的 upstream `AGENTS.md` 与 `docs/architecture.md`；
6. 在官方 Reference 或 `docs/subsystems/` 中建立领域心智模型；
7. 从公开类型或协议入口追踪生产方、事件、状态变化和消费方；
8. 用对应 revision 的 upstream 测试或本仓库最小 probe 验证理解；
9. 在 `how-dsh-works/` 中分别记录源码事实、runtime 观察、推断和未确认内容。

按问题使用下列源码路由。路径相对于 [DSH upstream](https://github.com/deepseek-ai/deepseek-harness) 根目录；developer preview 期间目录可能变化，找不到时先用 `rg` 查类型、方法或事件名，不要猜测替代路径。

| 想理解什么 | 先读官方文档 | 再读源码 |
| --- | --- | --- |
| DSH 如何启动和组装 plugin tree | `docs/architecture.md`、`docs/cordis-primer.md` | `packages/boot/app-boot/src/`、`packages/bundle/*/` |
| Agent 接口、inbox、状态和生命周期句柄 | `docs/subsystems/core.md` | `packages/core/agent/src/` |
| agent loop、turn、step 和模型/工具推进 | `docs/agent-lifecycle.md`、`docs/tool-execution-pipeline.md` | `packages/core/agent-loop/src/` |
| SessionEvent、事件日志和 fork | `docs/subsystems/session.md`、`docs/persistence-catalog.md` | `packages/core/session/src/` |
| session 持久化、投影、标题和遥测 | `docs/subsystems/persistence.md`、`docs/subsystems/session-projection.md` | `packages/session/*/src/` |
| 模型消息与流式 chunk | `docs/subsystems/llm-streaming.md` | `packages/llm/llm/src/`、对应 provider 的 `src/` |
| 工具注册和执行管线 | `docs/subsystems/tools.md`、`docs/tool-execution-pipeline.md` | `packages/core/tools/src/`、各能力的 tool package |
| subagent provider、继承和生命周期 | `docs/subsystems/subagent.md` | `packages/subagent/*/src/` |
| SDK JSON-RPC 方法、通知和 JSONL 分帧 | `packages/sdk/protocol/README.md`、`packages/sdk/server/README.md` | `packages/sdk/protocol/src/types.ts`、`packages/sdk/protocol/src/transport.ts`、`packages/sdk/server/src/server.ts` |
| TypeScript SDK 高层/底层客户端 | `packages/sdk/client/README.md` | `packages/sdk/client/src/api.ts`、`packages/sdk/client/src/client.ts` |
| Python SDK 如何拉起 runtime 和界定 run | [Python SDK](https://deepseek-harness.github.io/deepseek-harness/guide/python-sdk) | `python/sdk/src/deepseek_harness/api.py`、`python/sdk/src/deepseek_harness/client.py` |
| ACP session、prompt、cancel 和 permission | `packages/acp/acp/README.md` | `packages/acp/acp/src/` |
| 官方 Web UI 的 RPC 和事件下行 | `docs/subsystems/web-server.md`、client subsystem docs | `packages/host/apiproxy/src/api/`、`packages/client/connection/src/`、相关 `ui-*` packages |
| Cordis context、service、事件和 waterfall | `docs/cordis-primer.md`、Cordis tutorial | `vendor/cordis/` |
| plugin 的 `apply`、`inject` 和资源清理 | [Plugin Development](https://deepseek-harness.github.io/deepseek-harness/develop/basic/) | 具体 plugin 的 `src/` 与目标 subsystem docs |

定位事件关系时优先搜索稳定机制名，例如：

```sh
rg -n "session/event|turn/start|tool/call" packages docs
rg -n "session/prompt|initialize" packages/sdk python/sdk
rg -n "request_permission|session/cancel" packages/acp
```

不要用 upstream `master` 的实现直接解释旧 lockfile 中的 runtime。版本无法对应时，明确标记版本差异，并把结论限制在实际检查的 revision。

## Learning Artifact Standards

### Tutorial

教程至少包含学习目标、前置知识、安装与运行、可执行代码、预期观察、源码说明、验证命令、限制和下一步。复杂流程增加 Mermaid。教程必须从零开始按顺序可执行。

### Lab

Lab 至少包含问题、版本和实验条件、最小复现、观察结果、结论、清理方式和仍未确认的内容。Lab 的结果不能自动扩大为生产保证。

### Project

Project 至少包含目标、架构、本地运行、配置、测试、业务状态与 runtime 状态的边界、安全限制，以及已实现/未实现能力。

### How DSH Works

源码和机制学习至少记录 DSH tag、release 或 commit SHA、入口文件、调用路径、关键类型/事件、最小验证探针和未确认部分。

明确区分：

```text
Verified from source
Observed at runtime
Inference
Proposal
```

不要复制整份 DSH 源码。引用固定 revision，并只摘录理解机制所需的最小片段。

## Evidence and Version Discipline

- 新实验记录 SDK/runtime 版本；源码学习记录 upstream commit SHA。
- 不根据一个客户端的方法推断服务器一定支持该语义。
- 不根据一个语言 SDK 推断另一个语言 SDK。
- focused test、一次真实运行和模型回复只证明各自覆盖的范围。
- keyless 测试与真实 API 测试分别报告；不要混写成同一种证据。
- 当 upstream 发生破坏性变化时，优先更新教程和 lockfile，不静默加入兼容层。
- 不确定或未验证的结论必须显式标注，不能写成当前事实。

## Toolchains and Commands

Python SDK 教程：

```sh
uv sync --project tutorials/python-sdk --group dev
uv run --project tutorials/python-sdk pytest tutorials/python-sdk/tests
uv run --project tutorials/python-sdk ruff check tutorials/python-sdk
uv run --project tutorials/python-sdk ruff format --check tutorials/python-sdk
```

FastAPI 101：

```sh
uv sync --project tutorials/fastapi-101 --group dev
uv run --project tutorials/fastapi-101 ruff check tutorials/fastapi-101
uv run --project tutorials/fastapi-101 ruff format --check tutorials/fastapi-101
uv run --project tutorials/fastapi-101 \
  pytest -c tutorials/fastapi-101/pyproject.toml \
  tutorials/fastapi-101/tests
```

从修改的最小子项目开始验证。修改跨目录文档时检查全部相对链接；修改 Web UI 时进行浏览器验证；只有相关行为需要时才调用真实模型。

## Safety and Repository Hygiene

这是 public GitHub 仓库：

- 不打印或提交 API Key、token、凭据、`.env`、cookie 或账户状态；
- 不提交 `.venv`、workspace、session 日志、Ruff/pytest cache 或临时生成物；
- 通用忽略规则由根 `.gitignore` 统一拥有；子项目只有独有运行产物时才增加局部 `.gitignore`，不要复制根规则；
- 凭据只通过环境变量传入，不写入示例、fixture、截图或终端记录；
- DSH 可以读写文件、运行命令和委派任务，工具实验只针对可丢弃 workspace、容器或明确 sandbox；
- 保留用户已有修改，不 reset、覆盖或顺手整理无关内容；
- 删除、移动或覆盖用户资料前确认目标与恢复方式。

## GitHub Publishing Boundary

Agent 可以主动编辑、运行测试，并准备 diff、验证摘要、建议的 commit message 和 PR 文本。未获得用户明确要求时不要执行 `git add`；`git commit`、`git push`、创建 release、修改 visibility 或其他外部发布动作同样需要用户明确要求。

`main` 是公开归档分支。push 前运行与改动相匹配的测试、Ruff、文档链接和密钥检查。一个 commit 对应一个完整学习增量；不要 force-push `main`，不要把不相关实验混进同一提交。
