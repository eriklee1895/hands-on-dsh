# Python App Builder

这条路线从一次 Python 调用开始，逐步把它变成长时间运行、能查询任务状态的服务。全程固定 Python SDK/runtime `0.1.5rc1`。你会反复遇到同一个问题：调用方看到的结果，是否足以说明 Agent 已经完成工作？

## 先在一个进程里完成两轮对话

从 [Python SDK 六章](../../tutorials/python-sdk/README.zh.md)开始。第一章拿到最终回答并关闭 runtime；第二章让同一个 Session 记住上一轮内容。接着观察通知、让工具写文件，最后拆开高层 SDK，看到底层 client 怎样订阅、提交输入、匹配回执和等待 idle。

完成这一段时，应能解释三个区别：runtime 进程与 Session、已提交消息与实时 token、模型回复与外部文件结果。同一进程内的会话复用先跑通，跨进程恢复留到有明确恢复入口时再验证。

## 把调用放进 FastAPI

[FastAPI 五章](../../tutorials/fastapi-101/README.md)提供一个可以直接运行的浏览器应用。先走 JSON 请求，再用 POST + SSE 观察状态、已提交正文和工具事件。随后让两个 Session 同时运行，观察每个 Session 的锁与整个服务的 runtime 生命周期。

同步 SDK 工作由线程执行，回调通过 asyncio 桥接到 HTTP 输出。浏览器断开只结束这次连接，已经开始的工作可能仍在继续。关闭服务时要等谁、如何回收子进程，是第五章的重点。

## 给任务一个持久的业务身份

进入 [Recoverable Agent Service](../../projects/recoverable-agent-service/README.md)。先创建 Conversation，再提交 Run、读回事件并下载产物。SQLite 持有这些业务记录，DSH Session ID 则是执行层引用。

现在重启服务。如果旧任务还处于 running，程序不能凭进程消失推断工具没执行；它将记录执行不确定，要求调用方核对外部状态后确认恢复。确认会允许提交新工作并旋转 Session ID，不会悄悄重放原 prompt。用[三种恢复对照](../comparisons/recovery-and-session-migration.md)检查自己是否把业务恢复、模型会话恢复和格式升级混在了一起。

## 怎样判断已经学会

先通过各项目的无 Key 测试和 Ruff 检查。真实任务按章节条件使用自己的 Key，观察原生结束原因、外部产物字节，以及关闭后 runtime 回收。对服务，还要核对持久事件游标、下载哈希和恢复确认后的新旧 Run。

当前版本的执行依据见 [SDK 迁移](../reviews/2026-09-28-sdk-migration.md)、[FastAPI/协议](../reviews/2026-09-29-web-protocol-migration.md)与[业务恢复](../reviews/2026-09-29-recovery-storage.md)。[8 月历史结果](../reviews/2026-08-31-python-app-history.md)另存原日期。下一步可走[工程化路线](engineering.md)，或从[协议实验](../../labs/protocol-semantics/README.md)继续理解客户端能力。
