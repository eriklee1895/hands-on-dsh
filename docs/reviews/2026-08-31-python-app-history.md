# Python 应用路线的历史验收

以下内容保留 2026-08-31 的原版本与运行结果，从学习路线移至此处集中查证；不是本轮重新执行。

## 阶段 0 验收记录 2026-08-31


以下为旧 Python `0.1.1rc1` 的历史记录，包含当时的 `assistant/chunk`；新版 SDK 入门验收单列于 SDK 迁移记录。

已完成六次全新的 Python SDK 真模型运行，分别验证高层调用的最终回复、两轮 session 复用、完成前到达的 text-delta、在模型回复之外检查输出的 workspace 工具任务、`HarnessClient` 在匹配的持久 inbox 回执和 idle 后完成结算，以及原始 JSON-RPC 的初始化、通知关联、关闭与 runtime 干净终止。

全新的 FastAPI 验证覆盖 JSON chat、命名 SSE、两轮记忆交互、输出经外部检查的 workspace 工具任务，以及两个独立 session 的并发运行。浏览器验证覆盖章节 UI 和一次真实流式交互的桌面与移动视口；同时检查 runtime 健康状态、外部工具状态，以及关闭后 runtime 进程已被回收。

已提交的无凭据检查当时通过 Python SDK 7 个测试和 FastAPI 11 个测试，并完成两套教程的 Ruff lint 与 format 检查。详细 transcript、截图和持久 session 日志属于本地 gitignored 证据，不进入跟踪文档；真模型的措辞与时延仍取决于 provider，因而并不确定。

一项仅限终端 harness 的操作观察并非应用保证：其 `uv` wrapper 未能及时转发 SIGINT。直接向 Uvicorn 发送 SIGINT 后，FastAPI lifespan 正常结束，并回收了 runtime。


## 阶段 1 历史验收记录（2026-08-31，Python 0.1.1rc1）

显式真实 DSH E2E 已实际运行，结果为 `1 passed in 9.68s`。完整 FastAPI lifespan 创建了 Conversation 和 Run，最终状态为 `succeeded`、`finish_reason=completed`；SQLite 持久化 134 条按 seq 排序的 RunEvents，末条为 `run.succeeded`，terminal SSE replay 正常结束。

外部 artifact 验证得到精确无换行字节 `RECOVERABLE_AGENT_SERVICE_E2E_PROOF_V1`，大小 38 bytes，SHA-256 为 `8f0b99fb14fe8b40932d1446c3a4e944e0aacca7e6944c251f442ba8328f5ae4`；下载内容来自 SQLite immutable BLOB。进程快照在运行前为零个匹配 runtime、运行中恰好一个、lifespan 退出后再次为零。交付前 fresh keyless regression 另有 129 passed、1 个显式 E2E deselected；真实与 keyless 证据不混写。
