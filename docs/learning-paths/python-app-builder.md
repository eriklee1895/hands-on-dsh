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

## 3. 下一步

在 `projects/` 中构建一个拥有业务 Conversation、Run 和 Artifact 状态的应用。需要深入协议时再进入 `labs/`，需要理解 DSH 生命周期实现时进入 `how-dsh-works/`。
