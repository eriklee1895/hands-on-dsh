# Python App Builder

目标：学会通过 Python SDK 管理 DSH runtime，并构建一个带流式前端的 Web Agent。

## 1. Python SDK 基础

完成 [`tutorials/python-sdk/`](../../tutorials/python-sdk/README.zh.md)：

- 运行与关闭 runtime
- 复用 session
- 读取流式通知
- 验证工具产生的外部状态
- 对照高层 SDK、`HarnessClient` 与裸 JSON-RPC

## 2. FastAPI Web Agent

完成 [`tutorials/fastapi-101/`](../../tutorials/fastapi-101/README.md)：

- 用 lifespan 拥有 runtime 进程
- 把同步回调桥接到 asyncio
- 通过 POST + SSE 输出浏览器事件
- 展示工具轨迹
- 管理 session 并发和优雅关闭

## 阶段 0 验收记录 2026-08-31

已完成六次全新的 Python SDK 真模型运行，分别验证高层调用的最终回复、两轮 session 复用、完成前到达的 text-delta、在模型回复之外检查输出的 workspace 工具任务、`HarnessClient` 在匹配的持久 inbox 回执和 idle 后完成结算，以及原始 JSON-RPC 的初始化、通知关联、关闭与 runtime 干净终止。

全新的 FastAPI 验证覆盖 JSON chat、命名 SSE、两轮记忆交互、输出经外部检查的 workspace 工具任务，以及两个独立 session 的并发运行。浏览器验证覆盖章节 UI 和一次真实流式交互的桌面与移动视口；同时检查 runtime 健康状态、外部工具状态，以及关闭后 runtime 进程已被回收。

已提交的无凭据检查当时通过 Python SDK 7 个测试和 FastAPI 11 个测试，并完成两套教程的 Ruff lint 与 format 检查。详细 transcript、截图和持久 session 日志属于本地 gitignored 证据，不进入跟踪文档；真模型的措辞与时延仍取决于 provider，因而并不确定。

一项仅限终端 harness 的操作观察并非应用保证：其 `uv` wrapper 未能及时转发 SIGINT。直接向 Uvicorn 发送 SIGINT 后，FastAPI lifespan 正常结束，并回收了 runtime。

## 3. 可恢复 Agent 服务

完成 [`projects/recoverable-agent-service/`](../../projects/recoverable-agent-service/README.md)：

- SQLite 持有 Conversation、Run、RunEvent 和 Artifact 权威状态
- 单 worker 从 durable queue 领取 Run，并区分已知失败与 `execution_uncertain`
- FastAPI 提交、查询、恢复确认和健康接口
- 按持久事件 seq 回放与 live tail 的命名 SSE
- 从保留目录描述符快照并通过 SQLite BLOB 下载的不可变产物
- Python 3.10 keyless 测试和显式真实 DSH E2E

本阶段的完成门槛是：无凭据测试、Ruff、lock 检查通过；显式真实 E2E 能创建 proof artifact、核对下载字节与哈希、观察 SSE 终态，并在 lifespan 退出后回收 runtime 进程。需要深入协议时再进入 `labs/`，需要理解 DSH 生命周期实现时进入 `how-dsh-works/`。

### 阶段 1 验收记录（2026-08-31）

显式真实 DSH E2E 已实际运行，结果为 `1 passed in 9.68s`。完整 FastAPI lifespan 创建了 Conversation 和 Run，最终状态为 `succeeded`、`finish_reason=completed`；SQLite 持久化 134 条按 seq 排序的 RunEvents，末条为 `run.succeeded`，terminal SSE replay 正常结束。

外部 artifact 验证得到精确无换行字节 `RECOVERABLE_AGENT_SERVICE_E2E_PROOF_V1`，大小 38 bytes，SHA-256 为 `8f0b99fb14fe8b40932d1446c3a4e944e0aacca7e6944c251f442ba8328f5ae4`；下载内容来自 SQLite immutable BLOB。进程快照在运行前为零个匹配 runtime、运行中恰好一个、lifespan 退出后再次为零。交付前 fresh keyless regression 另有 129 passed、1 个显式 E2E deselected；真实与 keyless 证据不混写。
