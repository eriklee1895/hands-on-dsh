# Python SDK 示例

[English](README.md) | 中文

这些示例从一次高层调用逐步深入到直接使用换行分隔的 JSON-RPC。示例使用 `deepseek-harness-sdk` 携带的运行时，因此安装正式发行版后不需要 Node.js，也不需要单独安装 `dsh` 可执行文件。

## 前置要求

- 在受支持的平台上安装 Python 3.10 或更高版本
- 为允许 agent 使用本地工具的示例准备一个可丢弃的 workspace
- 根目录 `.env` 中设置 `DEEPSEEK_API_KEY`；通过兼容代理提供模型时再设置 `DEEPSEEK_BASE_URL`

进入该项目并同步锁定的 runtime 与开发工具。建议本地真实模型运行时显式加载根目录 `.env`；执行下面的 `cd` 后，`../../.env` 正是该文件：

```sh
cd tutorials/python-sdk
uv sync --group dev
```

不要把凭据写入 Git。如果 shell 已经 `export` 这些变量，可从相同命令中省略 `--env-file ../../.env`；本 README 不应写入真实值。

## 学习路径

| 示例 | API 层级 | 演示内容 | 教程 |
|---|---|---|---|
| [`01_hello.py`](01_hello.py) | `DeepSeekHarness.run()` | 一条提示词、最终回复、会话 ID 与结束原因 | [一次高层运行](tutorials/01-hello.zh.md) |
| [`02_reuse_session.py`](02_reuse_session.py) | `Session.run()` | 复用一个运行时进程，并在同一会话中执行两个轮次 | [复用运行时与会话](tutorials/02-reuse-session.zh.md) |
| [`03_stream_events.py`](03_stream_events.py) | 高层回调 | 从 `assistant/chunk` 通知投影出实时提交的文本 | [流式输出已提交文本](tutorials/03-stream-events.zh.md) |
| [`04_workspace_agent.py`](04_workspace_agent.py) | 高层工具 | 在指定 workspace 中读取和写入文件的任务 | [在 workspace 中运行工具](tutorials/04-workspace-agent.zh.md) |
| [`05_low_level_client.py`](05_low_level_client.py) | `HarnessClient` | 初始化、提示词入队、持久 inbox 回执、事件与空闲结算 | [驱动 `HarnessClient`](tutorials/05-low-level-client.zh.md) |
| [`06_raw_jsonrpc.py`](06_raw_jsonrpc.py) | 原始 stdio JSON-RPC | 启动进程、JSONL 分帧、关联响应、消费通知与清理资源 | [手写 JSON-RPC](tutorials/06-raw-jsonrpc.zh.md) |

从 `tutorials/python-sdk` 目录运行示例：

```sh
uv run --env-file ../../.env python 01_hello.py
uv run --env-file ../../.env python 02_reuse_session.py
uv run --env-file ../../.env python 03_stream_events.py
uv run --env-file ../../.env python 04_workspace_agent.py
uv run --env-file ../../.env python 05_low_level_client.py
uv run --env-file ../../.env python 06_raw_jsonrpc.py
```

每个脚本都接受 `--help`。第一个、第三个、第五个与第六个脚本还接受位置参数形式的提示词。

## 质量检查

`dev` 依赖组提供 pytest 与 Ruff，无需安装全局工具即可检查行为、lint 和格式：

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

使用 `uv run ruff format .` 应用 Ruff 格式化。通过 uv 更新依赖，让 `pyproject.toml` 与 `uv.lock` 保持同步。

## 流式行为

Python SDK 通过 `on_notification` 支持通知流式传输。`Session.run()` 执行期间，回调会收到包含 `assistant/chunk` 事件的 `session.event` 通知。当 `event.data.chunk` 的类型为 `text-delta` 时，其中包含已提交的文本增量；推理增量与工具调用增量使用其他分片类型。回调还可能收到已知后代会话的通知，因此示例通过根 `sessionId` 筛选文本。

`Session.run()` 仍然是同步调用，只有其拥有的活动区间抵达下一次整个 agent 的 `idle` 状态时才返回。SDK 目前没有提供 `for chunk in stream` 形式的专用迭代器；`03_stream_events.py` 演示了面向终端、SSE 或 WebSocket 输出所需的小型投影。

## 选择集成层级

| 选择 | 适用情况 | 调用方职责 |
|---|---|---|
| `DeepSeekHarness` | 业务需要提示词、最终回复、通知与会话复用 | 管理运行时上下文与应用级任务状态 |
| `HarnessClient` | 业务需要直接订阅通知或获取提示词入队回执 | 关联活动区间并投影结果 |
| 原始 JSON-RPC | 诊断协议、验证另一个 SDK 的原型，或绕过仅存在于客户端的限制 | 管理进程生命周期、并发排空 stdout/stderr、关联请求、路由通知、超时、协议校验与资源清理 |

原始 JSON-RPC 无法增加 DSH JSON-RPC 服务器没有实现的方法。业务应优先扩展服务器，并在 `HarnessClient` 中封装新方法，而不是在每个应用中重复实现传输代码。

## 安全与结果语义

- 内置运行时可以暴露本地文件与进程工具。请把 `cwd` 指向可丢弃的 checkout 或其他隔离 workspace。
- 未通过 `--session-root` 覆盖时，示例把持久日志保存在当前目录的 `.dsh-python-demo-sessions` 下。
- `session/prompt` 响应只确认消息已入队，并不是 agent 结果。低层示例先把其中的 `messageId` 与 `agent/inbox/spliced` 关联，再等待 `session.status=idle`。
- `Session.run()` 返回的最终回复与结束原因描述其拥有的活动区间。agent 进入空闲状态前，其他已排队工作也可能参与其中。
- 独立业务任务应使用不同的会话 ID。只有下一轮需要保留对话与运行时状态时才复用会话 ID。
