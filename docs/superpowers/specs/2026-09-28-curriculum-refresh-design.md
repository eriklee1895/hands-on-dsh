# DSH 教程更新与工程化第一课

## 目标

继续以“每阶段有可运行作品”为目标学习 DSH。先审查 2026-08-31 以来的上游变化，明确旧教程的有效版本，再进入工程化专题。此次执行交付版本审查、后续路线和第一课；后续各课独立迁移、验证，不把旧验收记录当作新版证据。

## 版本选择

2026-09-28 查询 GitHub release 与 npm，TypeScript 新增内容固定 `0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`。PyPI 最新发布是 `0.1.5rc1`，旧 Python lockfile 实际为 `0.1.1rc1`；两者都不是 `0.1.7-rc.2`。旧内容继续按各自 lockfile 运行，升级完成前明确标注。上游 master `21638c56315ae6a2b552d6091945d3144c9af32e` 仅作为发布后变化观察点。

## 方案

采用逐模块迁移。一次性全量升版会同时改变启动、持久化、流式输出和 provider，失败时难以定位；只追加新章节则会继续把旧 API 教给新读者。先写版本差异与逐模块验收矩阵，在现有目录加版本提示，再通过一个独立 lab 验证新版公开 SDK 的生命周期。

新 lab `labs/runtime-supervision/` 使用发布的 TypeScript SDK 和同版本 dsh，由公开 profile 启动。第一课只管理一个 runtime slot：串行接纳调用；成功后复用 runtime；调用失败或超时后等待 SDK `close()`；关闭成功后，下一次显式调用才建立新 generation；关闭失败进入隔离状态，拒绝继续接单。任何失败都不自动重放 prompt，避免重复工具副作用。

公开接口为 `RuntimeSupervisor.run(prompt)` 与 `close()`。构造参数提供 factory 和总活动时限。run 时限包含启动与运行，不等于单次 JSON-RPC timeout；超时后仍等待 SDK 有界回收，不能把 deadline 描述为完整 API 的硬返回时限。`RunResult` 的业务/模型终态由消费者读取，run resolve 仅说明 SDK interval 完成。

## 证据与交付

- 审查记录链接固定 revision 的官方源码，并分开列出 GitHub、npm、PyPI、本地 manifest/lockfile。
- Vitest fake timers 与可控 promises 覆盖正常复用、并发拒绝、timeout、调用失败、关闭失败、关闭与运行竞争、显式重建及迟到结果；不调用模型。
- 通过公开 SDK 启动实际 `sdk-minimal` profile，完成 initialize/close；这属于真实进程 smoke，不冒充真实模型 E2E。
- 如果有可用凭据，执行一次真实 prompt，单独记录结果与局限；如果发布包不能运行，保留原始错误和最小复现，不使用私有 launcher 绕过。
- Node `^22.19.0 || >=24.0.0`，TypeScript strict ESM/NodeNext，pnpm lockfile；每个命令写明工作目录。
- 所有历史记录保留版本边界；主线不修改 DSH upstream；不 stage、commit 或 push。

## 后续分课

1. 更新 Python 与 TypeScript 入门：profile/home/patch、SDK 对比与冻结依赖。
2. 更新事件与持久化：V4、实时输出与 durable stream、相邻迁移、恢复验证。
3. 更新 Cordis/plugin/preset 与 AG-UI 项目：移除失效启动入口，逐项重审 resume adapter。
4. 在 supervisor 上增加进程池与故障注入，再做认证/租户、sandbox、可观测性、eval/replay、跨 runtime 适配。

进程池、Web UI、认证与 sandbox 不包含在第一课中；`dshHome` 和临时 workspace 只隔离文件位置，不提供安全隔离。
