# Labs

这里保存针对单一机制的短实验。每个 lab 应该有一个清晰问题、最小代码、可重复验证命令和结论。

已完成：

- [protocol-semantics](protocol-semantics/README.md)：SDK JSON-RPC / ACP 的 JSONL、committed output、cancel、permission、错误与 source-process lifecycle
- [cordis-plugin-lifecycle](cordis-plugin-lifecycle/README.md)：原创 proof journal、Cordis lifecycle/HMR/PENDING、可复用 DSH tool/listener 与真实模型调用

计划中的实验：

- runtime supervisor / process-pool failure injection
- 认证、多租户与 sandbox isolation probes
- DSH / ACP / Codex / Hermes adapter 的共同 transcript fixture

教程可以引用 lab，但不复制其实现。完整应用则放在 `projects/`。
