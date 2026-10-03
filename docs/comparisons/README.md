# 在实际例子之间作选择

同一个“运行 Agent”的需求，可以从不同语言、协议和界面进入。先运行相应例子，再用下面的比较检查自己到底需要哪一种控制、事件和恢复方式。

| 面临的选择 | 阅读入口 |
| --- | --- |
| Python 后端还是 Node BFF，启动与环境有什么差别？ | [Python 与 TypeScript SDK](python-vs-typescript-sdk.md) |
| 需要原始日志，还是标准会话控制和权限交互？ | [SDK JSON-RPC 与 ACP](sdk-jsonrpc-vs-acp.md) |
| 重启后要恢复的是任务、模型上下文还是文件格式？ | [三种恢复](recovery-and-session-migration.md) |
| 哪些事件用于诊断，哪些事件用于界面？ | [Session events 与 AG-UI](session-events-vs-ag-ui.md) |
| 提交、实时输出和断线重放分别走哪条连接？ | [SSE 与 WebSocket](sse-vs-websocket.md) |
| 同一任务换一个引擎后，如何确认完成？ | [DSH、Codex 与 Hermes](dsh-codex-hermes.md) |

每篇限定实际版本与本仓库实现。能力矩阵用于解释这些例子的选择依据，性能、生产隔离和其他版本的兼容性仍需独立证据。
