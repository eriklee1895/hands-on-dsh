# 用小实验解释一个问题

Lab 适合在“例子能跑”之后继续追问。一次实验只改变少量条件，同时观察调用结果、日志和外部状态。你可以按[工程化路线](../docs/learning-paths/engineering.md)顺序学习，也可以从眼前的问题进入。

| 你想弄清的问题 | 实验入口 |
| --- | --- |
| 超时后进程还在，下一条请求能借它吗？ | [单 runtime 管理](runtime-supervision/README.md) → [有界进程池](runtime-supervision/POOL.md) |
| SDK 的入队回执、ACP 的结束响应各代表什么？ | [协议语义](protocol-semantics/README.md) → [跨引擎适配](protocol-semantics/ADAPTERS.md) |
| 依赖服务被卸载后，插件留下的 listener 归谁清理？ | [Cordis 生命周期](cordis-plugin-lifecycle/README.md) |
| 历史文件能读出来，磁盘格式就已经变了吗？ | [Session 迁移](session-format-migration/README.md) → [压缩历史与附件](session-format-migration/RICH-HISTORY.md) |
| 日志还在，模型为什么忘记了一部分内容？ | [上下文压缩](compaction-lifecycle/README.md) → [溢出/取消](compaction-lifecycle/RECOVERY.md) → [裁剪/offload](compaction-lifecycle/REDUCTION.md) |
| 压缩调用报错，checkpoint 会不会已经提交？ | [事务与并发](compaction-lifecycle/TRANSACTIONS.md)；另有[真实服务端 overflow](compaction-lifecycle/PROVIDER-OVERFLOW.md) |
| 模型看到的图片与上传、存储的是同一份吗？ | [附件输入](attachment-input/README.md) → [fallback](attachment-input/FALLBACK.md) → [预算](attachment-input/BUDGET.md) → [失效 ID](attachment-input/STALE.md) |
| 子 Agent 结束或进程重启后，哪些关系仍能找回？ | [Workflow 与 child](workflow-child-lifecycle/README.md) → [故障与森林恢复](workflow-child-lifecycle/RECOVERY.md) |
| 浏览器断线、取消、Host 崩溃分别影响谁？ | [官方 Web](web-host-lifecycle/README.md) → [控制案例](web-host-lifecycle/CONTROLS.md) → [恢复实验](web-host-lifecycle/RECOVERY.md) |
| workspace 写入策略与容器隔离分别限制了什么？ | [本机 sandbox](sandbox-isolation/README.md) → [Linux 容器/SSH](sandbox-isolation/CONTAINERS.md) |
| 同一份日志导入两遍，usage 会不会算两次？ | [Run 观测与费用演算](run-observability/README.md) |

每个入口都声明版本、运行条件与清理责任。先跑确定性案例，再决定是否使用自己的模型凭据。完整生产多租户调度、任意故障恢复和跨平台保证，仍需按实际场景验证；各实验的观察不自动扩大到这些范围。
