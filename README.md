# Hands-on DSH

通过构建应用、探索协议和阅读内部机制来学习 DeepSeek Harness（DSH）。

这个仓库服务于我的个人学习：从 Python SDK 的最小调用开始，逐步构建 FastAPI Web Agent，继续探索 ACP、TypeScript SDK、TypeScript full-stack，最后进入 DSH 核心源码与插件体系。

> Learn DSH by building agent applications, exploring protocols, and understanding its internals.

## 当前进度

### ✅ Python SDK：由浅入深

[`python-sdk/`](python-sdk/README.zh.md)包含 6 个已实现并实测的示例：

1. `DeepSeekHarness.run()` 最小调用
2. runtime 进程与多轮 session 复用
3. `assistant/chunk` 流式文本输出
4. workspace 文件与工具调用
5. 底层 `HarnessClient` 生命周期
6. 手写 stdio JSON-RPC

每个示例都有独立教程、源码说明和 Mermaid 流程图。示例已经使用真实 DeepSeek API 验证。

### ✅ FastAPI 101：从零构建 Web Agent

[`fastapi-101/`](fastapi-101/README.md)是一套完整、可运行的中文入门课程：

- FastAPI lifespan 管理一个长期运行的 DSH runtime
- 同步 JSON API
- POST + SSE 流式事件
- 浏览器多轮 session
- 工具调用、工具结果与 Agent 轨迹
- 同 session 串行、跨 session 并发
- runtime shutdown 与子进程回收
- 原生 HTML/CSS/JavaScript 前端

项目包含单元测试、真实模型测试、浏览器验证、Mermaid 图和架构插图。

## 学习路线图

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

### Phase 2 — ACP

- [ ] 理解 ACP 初始化、session、prompt、cancel 与 permission 语义
- [ ] 启动并手动驱动 DSH ACP server
- [ ] 编写最小 ACP 客户端
- [ ] 对比 SDK JSON-RPC 与 ACP 的能力和事件模型
- [ ] 构建一个编辑器式 ACP Web 客户端实验
- [ ] 记录 DSH 当前 ACP 的能力边界与适用场景

### Phase 3 — TypeScript 调用 DSH

- [ ] 安装并体验 `@deepseek-ai/dsh-sdk-client`
- [ ] 管理 TypeScript 侧 runtime 命令与子进程生命周期
- [ ] 使用高层 `DeepSeekHarness` 与底层 `HarnessClient`
- [ ] 处理 notification stream、session 与 subagent 事件
- [ ] 编写 TypeScript JSON-RPC 对照实验
- [ ] 对比 Python 与 TypeScript SDK 的开发体验和能力差异

### Phase 4 — TypeScript full-stack Agent 应用

- [ ] TypeScript BFF 管理 DSH runtime
- [ ] React + TypeScript Agent UI
- [ ] SSE / WebSocket 流式传输
- [ ] 多 session、工具轨迹与 subagent 展示
- [ ] 应用自己的 Conversation / Run / Artifact 状态模型
- [ ] 断线恢复、背压、错误与优雅关闭
- [ ] sandbox、认证和多租户边界

### Phase 5 — DSH 内部机制与源码学习

- [ ] Cordis plugin tree、effect 与 service
- [ ] `Agent`、inbox 与 agent loop
- [ ] turn / step / tool 执行流水线
- [ ] durable session event log 与消息派生
- [ ] compaction 与 context assembly
- [ ] subagent、workflow 与后台任务
- [ ] SDK JSON-RPC server/client 源码追踪
- [ ] ACP server 源码追踪
- [ ] Web Host RPC 与 DSH 官方 Web 客户端架构
- [ ] 编写自定义 DSH plugin 与 Cordis 配置实验

### Phase 6 — 工程化专题

- [ ] runtime supervisor 与进程池
- [ ] 业务状态与 runtime session 的边界
- [ ] 可观测性、token 用量与审计
- [ ] eval、回放与 keyless 测试
- [ ] 容器化 workspace 与远程 sandbox
- [ ] 协议适配层：DSH / ACP / Codex / Hermes

## 仓库结构

```text
hands-on-dsh/
├── python-sdk/       # 6 个 Python SDK / JSON-RPC 示例
├── fastapi-101/      # Python Web Agent 入门课程
├── acp/              # 未来：ACP 实验
├── typescript-sdk/   # 未来：TypeScript SDK
├── fullstack-ts/     # 未来：TypeScript full-stack
└── internals/        # 未来：源码与内部机制学习
```

未开始的目录暂不创建，以路线图为准逐步加入。

## 快速开始

### Python SDK

```sh
uv sync --project python-sdk --group dev
export DEEPSEEK_API_KEY=your-key
uv run --project python-sdk python python-sdk/01_hello.py
```

### FastAPI 101

```sh
cd fastapi-101
uv sync --group dev
uv run python -m dsh_fastapi_101
```

然后访问 `http://127.0.0.1:8000/chapter/1`。

## 验证

```sh
uv run --project python-sdk pytest python-sdk/tests
uv run --project python-sdk ruff check python-sdk
uv run --project python-sdk ruff format --check python-sdk
uv run --project fastapi-101 pytest -c fastapi-101/pyproject.toml fastapi-101/tests
```

## 学习原则

- 先运行，再阅读源码
- 用真实外部状态验证 Agent 工作，不只相信模型回复
- 区分业务 Task / Run 与 runtime session
- 区分高层 SDK、底层客户端和协议本身
- 每个主题都保留可运行 demo、完整教程和验证命令
- 凭据只放环境变量，不写入代码、文档或 Git

## 安全说明

DSH 工具可能使用本地文件和进程权限。文件与命令示例只应针对可丢弃 workspace、容器或明确配置的 DSH sandbox 运行。

本仓库不复制 DSH 核心源码。教程使用已发布的 SDK/runtime，并在需要时链接到 [DeepSeek Harness 官方仓库](https://github.com/deepseek-ai/deepseek-harness)解释关键机制。
