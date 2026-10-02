# 把示例接成一个应用

单个 SDK 调用结束时，程序可以直接退出。服务却要面对下一位调用者、浏览器断线和进程重启。这两个项目把这些问题放到同一套可运行代码里，让业务状态、runtime 与界面各自承担明确职责。

[Recoverable Agent Service](recoverable-agent-service/README.md)从 Python SDK/runtime `0.1.5rc1` 出发，用 SQLite 保存 Conversation、Run、事件和不可变产物。你会提交任务、按游标读回事件，并在执行结果不确定时确认恢复。随后可加上[租户认证](recoverable-agent-service/TENANCY.md)与[可重放评测](recoverable-agent-service/EVAL.md)。

[AG-UI DSH Runtime](ag-ui-dsh-runtime/README.md)使用 npm `0.1.7-rc.2`、Fastify、React 和 CopilotKit。除了业务状态，你还能观察界面事件怎样从 DSH 通知投影出来，浏览器断开后如何追赶，以及 runtime 换代后如何通过项目适配器恢复 Session。

先沿项目的一条完整任务路径运行，再阅读抽象接口。可复用适配器保留在实际消费者附近；遇到第二个用途后，再判断哪些职责适合提取。
