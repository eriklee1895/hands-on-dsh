# How DSH Works

这里从自学视角解释 DSH 为什么这样运行，包括架构图、源码路径、最小探针和验证证据。内容不以逐文件翻译源码为目标，而是围绕一个可观察机制建立理解。

计划中的主题：

- Cordis plugin tree、service 与 effect
- Agent inbox 和 agent loop
- turn、step 与工具执行流水线
- durable session events 与消息派生
- runtime startup、idle 与 shutdown
- context assembly 与 compaction
- subagent 与 workflow
- SDK JSON-RPC、ACP 和 Web Host RPC

面向使用者的步骤留在 `tutorials/`，孤立实验留在 `labs/`。
