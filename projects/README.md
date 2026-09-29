# Projects

这里保存可以作为完整应用运行和演示的学习成果。一个 project 可以同时使用 Python、TypeScript、JSON-RPC、ACP、AG-UI 或 DSH plugins；归属由最终应用决定，而不是由单一技术决定。

已实现项目：

- [`recoverable-agent-service/`](recoverable-agent-service/README.md)：固定 Python SDK/runtime `0.1.5rc1`，以 SQLite 为业务状态真源，提供 durable Run worker、FastAPI、SSE 断线重放、执行不确定性确认和不可变产物下载。
- [`ag-ui-dsh-runtime/`](ag-ui-dsh-runtime/README.md)：TypeScript/Fastify 持有 DSH runtime 与 SQLite 业务状态，React/CopilotKit 投影 AG-UI；固定 npm `0.1.7-rc.2`、公开 profile 与项目恢复适配器；当前 tool/model、跨 generation session、断线游标与浏览器验收见项目记录。

可复用适配器先留在第一个真实项目中；只有出现第二个消费者时再提取，避免为了目录整洁过早抽象。
