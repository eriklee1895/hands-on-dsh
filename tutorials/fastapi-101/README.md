# DSH FastAPI 101：从零构建 Web Agent

这是一套独立于 DeepSeek Harness 原仓文档的中文入门教程。“101”表示从零开始的基础课程，不是案例编号。项目用 FastAPI、原生 HTML/CSS/JavaScript 和已发布的 `deepseek-harness-sdk`，演示如何把 DSH 作为本地 agent runtime 嵌入自己的 Web 业务。

![浏览器、FastAPI、异步桥与 DSH runtime 的概念架构](assets/dsh-fastapi-architecture.png)

生成图用于建立直觉，下面的 Mermaid 和源码才是精确机制。

## 你会构建什么

一个 FastAPI 进程在 lifespan 中拥有一个 DSH runtime 子进程。浏览器可以发送同步请求，也可以通过 POST + SSE 接收文本、工具与生命周期事件；多个业务 session 共享 runtime，但对话历史和同 session 的并发控制相互隔离。

```mermaid
flowchart LR
    Browser[Browser UI] -->|POST JSON| FastAPI[FastAPI routes]
    Browser <-->|Named SSE frames| FastAPI
    FastAPI --> Service[RuntimeService]
    Service --> Queue[asyncio.Queue]
    Service --> Worker[Worker threads]
    Worker <-->|Python SDK| Runtime[dsh-jsonrpc-agent]
    Runtime --> Model[DeepSeek endpoint]
    Runtime --> Tools[Workspace tools]
    Runtime --> Logs[Durable session logs]
    Queue --> FastAPI
```

## 学习路径

整套 101 只有一个可运行 demo，教程按五章逐步打开能力：

1. [第一章：FastAPI 阻塞式 API](src/dsh_fastapi_101/static/tutorials/01-blocking-api.md)
2. [第二章：POST + SSE 流式输出](src/dsh_fastapi_101/static/tutorials/02-sse-stream.md)
3. [第三章：浏览器多轮会话](src/dsh_fastapi_101/static/tutorials/03-multi-turn-session.md)
4. [第四章：工具与 Agent 轨迹](src/dsh_fastapi_101/static/tutorials/04-tool-trajectory.md)
5. [第五章：Runtime 生命周期与并发](src/dsh_fastapi_101/static/tutorials/05-runtime-lifecycle.md)

建议按顺序阅读。前端左侧导航对应这五章，每一章都复用同一套后端并突出一个新概念。

## 安装

要求 Python 3.10 或更高版本，以及受 `deepseek-harness-runtime-bin` 支持的平台。推荐使用 uv：

```sh
cd tutorials/fastapi-101
uv sync --group dev
```

设置模型凭据。不要把密钥写进源码、`.env` 示例或 Git：

```sh
export DEEPSEEK_API_KEY=your-key
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
# export DSH_MODEL=deepseek-v4-flash
```

项目依赖把 SDK 限制在 `>=0.1.1rc1,<0.2`。安装 SDK 会自动安装完全匹配的 runtime wheel，目标机器不需要 Node.js。

## 启动

```sh
uv run python -m dsh_fastapi_101
```

打开：

- `http://127.0.0.1:8000/chapter/1`：教程前端
- `http://127.0.0.1:8000/docs`：FastAPI OpenAPI UI
- `http://127.0.0.1:8000/api/health`：runtime 健康状态

服务默认只监听 loopback。不要在没有认证、租户隔离、CSRF/Origin 策略和 workspace 沙箱时绑定到公网地址。

## API

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/health` | 检查 FastAPI lifespan 是否已启动 runtime |
| `POST` | `/api/chat` | 等待一次活动区间完成并返回 JSON |
| `POST` | `/api/chat/stream` | 在一个 POST 响应中返回命名 SSE 事件 |
| `GET` | `/api/sessions` | 列出当前服务进程接纳过的 session ID |

`/api/chat` 和 `/api/chat/stream` 都接收：

```json
{
  "session_id": "my-conversation",
  "prompt": "请检查 workspace 并回答问题"
}
```

## 浏览器事件

`src/dsh_fastapi_101/events.py` 不把完整 DSH 事件原样透传，而是投影成应用拥有的词汇：

- `text_delta`
- `status`
- `lifecycle`
- `tool_call`
- `tool_result`
- `subagent_started`
- `subagent_finished`
- `final`
- `error`

模型推理增量、完整请求头和未知插件事件不会进入浏览器流。原始事实仍保留在 DSH 持久会话日志中。

## 源码地图

| 文件 | 职责 |
|---|---|
| `src/dsh_fastapi_101/app.py` | FastAPI lifespan、JSON/SSE 路由和静态前端 |
| `src/dsh_fastapi_101/runtime.py` | runtime 进程所有权、线程桥、session 锁与关闭结算 |
| `src/dsh_fastapi_101/events.py` | DSH Notification 到 BrowserEvent 的安全投影 |
| `src/dsh_fastapi_101/models.py` | 应用自己的 HTTP 请求与结果模型 |
| `src/dsh_fastapi_101/static/` | 无构建步骤的浏览器 UI 与五章教程 |
| `tests/` | API、事件、并发、生命周期和教程完整性测试 |

## 配置

| 环境变量 | 默认值 | 作用 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 无 | DeepSeek 模型凭据 |
| `DEEPSEEK_BASE_URL` | SDK 默认 | OpenAI 兼容模型端点 |
| `DSH_MODEL` | `deepseek-v4-flash` | 模型 ID |
| `DSH_PROVIDER` | `deepseek-official` | DSH provider 路由 |
| `DSH_FASTAPI_WORKSPACE` | `workspace` | agent 工作目录 |
| `DSH_FASTAPI_SESSION_ROOT` | `.sessions` | DSH 持久会话目录 |

目录只在 lifespan 启动时创建；单纯 import 应用不会修改文件系统。

## 测试

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

测试使用假的 harness 验证应用语义，不调用模型。Ruff 负责 lint 和格式检查。真实端到端验证需要环境中的 `DEEPSEEK_API_KEY`，然后启动服务并使用 curl 或浏览器发送任务。

## 生产化前必须补齐

- 身份认证、租户授权与 session 所有权校验
- 业务数据库中的 Conversation、Run、Artifact 与事件序号
- workspace 容器或 DSH sandbox 隔离
- 工具结果截断、敏感字段清理与审计
- SSE 心跳、断线重放、背压和多消费者 fan-out
- runtime supervisor、资源配额与多进程部署策略
- 服务器协议支持后的 cancel、approval、ask-user 与 session 管理

当前 SDK JSON-RPC 是“详细观察、有限控制”。手写 JSON-RPC 不会凭空增加服务器没有的方法；业务扩展应优先补服务器语义，再由 Python SDK 封装。

## 插图说明

`assets/dsh-fastapi-architecture.png` 由内置 image generation 工具生成，最终提示词要求一个无文字、16:9、紫色与青色的开发者架构插图，依次表现浏览器、Web 服务、异步队列/工作线程、agent runtime、模型云与本地工具，并用反向粒子流表示流式事件。它不包含协议字段，避免与源码发生语义漂移。
