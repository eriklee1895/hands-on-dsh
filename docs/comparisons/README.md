# Comparisons

这里保存需要同时考察多个实现或协议的横向比较。每份比较应先给出使用场景，再列能力、生命周期、事件粒度和缺失项，避免只比较 API 名称。

已完成：

- [SDK JSON-RPC 与 ACP](sdk-jsonrpc-vs-acp.md)：方法、事件、控制、错误、打包与适用场景
- [Python SDK 与 TypeScript SDK](python-vs-typescript-sdk.md)：发布包、runtime 启动、流式通知、生命周期与选型

- [业务恢复、会话恢复与格式迁移](recovery-and-session-migration.md)：SQLite、ACP resume 与不可变 Session generation 各自保证什么

- [DSH Session events与AG-UI](session-events-vs-ag-ui.md)：执行事实、业务游标、UI投影与实时语义
- [SSE与WebSocket](sse-vs-websocket.md)：本仓库两条实际链路、断线与恢复依据

- [DSH、Codex和Hermes](dsh-codex-hermes.md)：共同任务、原生终态、能力声明与真实验收
