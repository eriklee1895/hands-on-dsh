# Labs

这里保存针对单一机制的短实验。每个 lab 应该有一个清晰问题、最小代码、可重复验证命令和结论。

已完成：

- [attachment-input](attachment-input/README.md)：真实附件 store、SDK 图片接纳、Files 视觉输入、字节核对与本次上传清理。

- [官方 Web Host](web-host-lifecycle/README.md)：浏览器认证、实时帧、工具产物、页面刷新及正常重启后的同会话续写；[控制案例](web-host-lifecycle/CONTROLS.md)验证审批、取消和离线行为。

- [Workflow PTC 与 child 冷恢复](workflow-child-lifecycle/README.md)：发布包 PTC、取消后的迟到 child 清理，以及两次独立 runtime 的持久 child 恢复和文件验证。
- [compaction-lifecycle](compaction-lifecycle/README.md)：真实发布engine的manual/auto/failure测试，真实pressure摘要、后续产物和持久surface重放；[溢出与取消](compaction-lifecycle/RECOVERY.md)验证受控故障、重试上限及迟到摘要；[裁剪/offload](compaction-lifecycle/REDUCTION.md)核对原始日志、模型输入、图片文件与重放。

- [run-observability](run-observability/README.md)：Run/session/attempt 时间线、用量去重、缺失项与费用估算；仅导出白名单元数据。

- [sandbox-isolation](sandbox-isolation/README.md)：macOS 三模式真实 provider 矩阵、两种受限模式的模型 Bash 调用，以及读取/网络/进程能力的实测限制。

- [session-format-migration](session-format-migration/README.md)：发布版 backend 的 synthetic V1/V3 → V4、只读/写入区别与不可变 generation。

- [runtime-supervision](runtime-supervision/README.md)：基于新版公开 SDK 的单 runtime 所有权、超时、隔离与显式重建；[第二课](runtime-supervision/POOL.md)扩展有界 FIFO 池与容量控制。
- [protocol-semantics](protocol-semantics/README.md)：固定 npm `0.1.7-rc.2` 的 SDK/ACP profiles、JSONL、committed output、cancel/permission、持久 session list/resume/close 与进程生命周期；[适配层](protocol-semantics/ADAPTERS.md)提供显式能力与共同场景
- [cordis-plugin-lifecycle](cordis-plugin-lifecycle/README.md)：固定 DSH `0.1.7-rc.2` 的原创 proof journal、Cordis lifecycle/HMR/PENDING、preset scope、可复用 tool/listener 与真实模型调用

计划中的实验：

- 容器/远程 executor 与多租户执行环境验证
- Codex / Hermes 等其他引擎的 adapter 接入与共同场景实测

教程可以引用 lab，但不复制其实现。完整应用则放在 `projects/`。
