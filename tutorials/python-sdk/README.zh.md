# Python SDK 示例

> 已验收版本（2026-09-28）：`deepseek-harness-sdk==0.1.5rc1` 与匹配的 `deepseek-harness-runtime-bin==0.1.5rc1`；对应上游 [`dsh-v0.1.5-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/183f08e9c6dde7e36cd2318eaee70b0da08fb35e)。

[English](README.md) | 中文

如果你的 Python 应用要把一项工作交给 Agent，第一步并不需要自己管理协议或事件队列。先运行一次高层调用，拿到回答；再保持会话聊第二轮，观察运行中的通知，最后让 Agent 写一个可独立核对的文件。前四例把这条路径走通，后两例再打开 SDK，解释它如何等待结果和回收进程。

这是“运行现成示例，再逐层拆解”的教程。每章链接完整脚本，给出应观察的结果和一个阅读或动手练习。SDK 依赖同版本 runtime wheel，后者携带公开的 `dsh` CLI 与 profile；无需为这些 Python 示例另装 Node.js。

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
| [`03_stream_events.py`](03_stream_events.py) | 高层回调 | 从通知投影根会话已提交的 `assistant/message` | [观察已提交消息](tutorials/03-stream-events.zh.md) |
| [`04_workspace_agent.py`](04_workspace_agent.py) | 高层工具 | 在指定 workspace 中读取和写入文件的任务 | [在 workspace 中运行工具](tutorials/04-workspace-agent.zh.md) |
| [`05_low_level_client.py`](05_low_level_client.py) | `HarnessClient` | 初始化、提示词入队、持久 inbox 回执、事件与空闲结算 | [驱动 `HarnessClient`](tutorials/05-low-level-client.zh.md) |
| [`06_raw_jsonrpc.py`](06_raw_jsonrpc.py) | 原始 stdio JSON-RPC | 启动进程、JSONL 分帧、关联响应、消费通知与清理资源 | [手写 JSON-RPC](tutorials/06-raw-jsonrpc.zh.md) |

第一次只运行第一个脚本，确认凭据和 runtime 能用，再按表中的章节往下走。以下命令均从 `tutorials/python-sdk` 目录执行；每条都显式加载 `.env`，因为前一次 `uv run` 不会替后续 shell 命令导出凭据：

```sh
uv run --env-file ../../.env python 01_hello.py
uv run --env-file ../../.env python 02_reuse_session.py
uv run --env-file ../../.env python 03_stream_events.py
uv run --env-file ../../.env python 04_workspace_agent.py
uv run --env-file ../../.env python 05_low_level_client.py
uv run --env-file ../../.env python 06_raw_jsonrpc.py
```

每个脚本都接受 `--help`。第一个、第三个、第五个与第六个脚本还接受位置参数形式的提示词。

除 `04_workspace_agent.py` 为文件工具选择完整的 `sdk` profile 外，脚本默认使用 `sdk-minimal`。全部支持 `--profile`、可重复的 `--patch`、`--workspace` 和 `--dsh-home`。默认临时 workspace 与 home 仅在运行时成功关闭后删除；关闭失败时保留供检查。显式 home 保存 profile 与会话数据。跨进程持久化调查需要保留 home 与同一会话 ID，本系列不声称已演示跨进程恢复。

## 质量检查

`dev` 依赖组提供 pytest 与 Ruff，无需安装全局工具即可检查行为、lint 和格式：

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

使用 `uv run ruff format .` 应用 Ruff 格式化。通过 uv 更新依赖，让 `pyproject.toml` 与 `uv.lock` 保持同步。

## 流式行为

第三例能在 `run()` 返回之前打印消息，但不要因此期待打字机效果。Python SDK 在同步的 `Session.run()` 期间调用 `on_notification`，我们取的是 DSH 已经提交的 `assistant/message` 文本块。模型内部逐 token 生成和客户端收到已提交消息，是两个不同的时刻。

回调还可能收到已知后代会话的通知。示例按根 `sessionId` 筛选，避免子 Agent 的回答覆盖主回答；工具和生命周期事件也不拼进最终文本。

`Session.run()` 是同步调用，在回执到整个 agent 空闲的活动区间结束时返回。SDK 没有逐 token 迭代器；`03_stream_events.py` 在事件抵达时输出每条已提交消息，随后与 `RunResult.final_response` 对照。

## 选择集成层级

| 选择 | 适用情况 | 调用方职责 |
|---|---|---|
| `DeepSeekHarness` | 业务需要提示词、最终回复、通知与会话复用 | 管理运行时上下文与应用级任务状态 |
| `HarnessClient` | 业务需要直接订阅通知或获取提示词入队回执 | 关联活动区间并投影结果 |
| 原始 JSON-RPC | 诊断协议、验证另一个 SDK 的原型，或绕过仅存在于客户端的限制 | 管理进程生命周期、并发排空 stdout/stderr、关联请求、路由通知、超时、协议校验与资源清理 |

选层级时，先问自己缺的是什么。如果只想知道 Agent 何时提交消息，高层回调已经够用；如果想观察入队回执，才需要底层客户端。第六例则主要帮助你理解客户端承担的工作。

原始 JSON-RPC 无法增加 DSH JSON-RPC 服务器没有实现的方法。需要新控制能力时，应先补服务器语义，再在 `HarnessClient` 中封装，避免每个应用重复实现传输代码。

## 发行版验收（2026-09-28）

已安装的 SDK 与 runtime 均报告 `0.1.5rc1`。在本教程目录通过 `uv run --env-file <path-to-env> python <script>`，使用 `deepseek-official` / `deepseek-v4-flash` 实跑，六例均以状态 0 退出。此版本官方适配器使用 Chat Completions API 与 Session V3；本次运行未设置 `DEEPSEEK_BASE_URL` 覆盖。此处不记录凭据。

| 脚本 | 观察结果 | 运行时后代进程：曾出现 / 退出后存活 |
| --- | --- | --- |
| `01_hello.py` | `hello from dsh`；completed | 2 / 0 |
| `02_reuse_session.py` | `stored`，随后 `SAFFRON`；completed | 2 / 0 |
| `03_stream_events.py` | 一条已提交消息与 `final_response` 一致；completed | 2 / 0 |
| `04_workspace_agent.py` | `output.txt` 精确字节 `b"blue\ngreen\nred\n"` 通过校验；completed | 2 / 0 |
| `05_low_level_client.py` | 根会话已提交回复 `low level client ok` | 2 / 0 |
| `06_raw_jsonrpc.py` | 根会话已提交回复 `raw json rpc ok` | 2 / 0 |

进程计数来自脚本外部的 `ps` 父子关系遍历及退出后的 PID 检查。生成的回复仅代表一次模型运行，不保证后续措辞。字节比较与进程观察独立于模型描述。

## 安全与结果语义

- 内置运行时可以暴露本地文件与进程工具。请把 `cwd` 指向可丢弃的 checkout 或其他隔离 workspace。
- 每个脚本新建临时 workspace 与 Harness home，关闭运行时后再删除。只有需要保留或查看时才传 `--dsh-home`、`--workspace`；独立运行使用不同路径。
- `session/prompt` 响应只确认消息已入队，并不是 agent 结果。低层示例先把其中的 `messageId` 与 `agent/inbox/spliced` 关联，再等待 `session.status=idle`。
- `Session.run()` 返回的最终回复与结束原因描述其拥有的活动区间。agent 进入空闲状态前，其他已排队工作也可能参与其中。
- 独立业务任务应使用不同的会话 ID。只有下一轮需要保留对话与运行时状态时才复用会话 ID。
