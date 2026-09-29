# Phase 7.2：有界 runtime 池验收

2026-09-29 完成[进程池教程](../../labs/runtime-supervision/POOL.md)。本批从 `4b4bf77` 继续，增加 RuntimePool、两个示例和课程说明；不接入现有 Web/AG-UI 服务，不改变单 runtime supervisor。设计和执行项分别见[设计](../superpowers/specs/2026-09-29-runtime-pool-design.md)与[计划](../superpowers/plans/2026-09-29-runtime-pool.md)。

## 版本与来源

macOS arm64，Node `26.7.0`，pnpm `12.3.4`；SDK/runtime 精确锁定 `0.1.7-rc.2`，Cordis `4.0.4`。没有变更依赖和 lockfile。启动使用公开 `sdk-minimal`、`patches`、`dshHome`、`processCwd`，不使用内部启动 argv。

按固定 tag 源码核对：[sdk-minimal profile](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/bundle/sdk-minimal/cordis.patch.yml)声明 `persistent-bash`/`persistent-pwsh`；真实示例禁用两者。[SDK API](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/api.ts)每次未指定 session 的 run 创建新 session，事件收集按根 session ID 过滤。此处核对的是教程 pin，不宣称当前上游 HEAD 已重新审查。

## 本地与可控故障

以下命令在 `labs/runtime-supervision` 中执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 32 项通过：既有 supervisor 20 项，新增 pool 12 项 |
| `pnpm pool:faults` | 2 active/2 queued；超限拒绝，排队 D 取消；B 失败回收后 C 使用 slot 2 generation 2；3 owner 均关闭，无重放 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过，无 warning |
| `pnpm format:check` | 通过 |
| `pnpm install --frozen-lockfile` | 通过，lockfile 未变 |

新增测试覆盖：参数范围和惰性启动、FIFO 与队列容量、排队 abort、派发前重新检查已过 deadline、清理结算前独占 slot、成功回收后的新 generation、部分/全部隔离、owner 复用、工厂重入、迟到完成，以及 drain close 的共享结果和多 slot 错误。故障来自可控 Promise 和 fake timer，不是对真实进程发送故障信号。

新增教程的 1 个 Mermaid 图通过 Mermaid 11.16.0 解析，涉及文档的 56 个本地文件链接均存在，`git diff --check` 通过。

独立 reviewer 检查实现、测试和两个示例，另行运行 32 项测试与故障示例，未发现需修复的问题。静态检查发现示例使用 `Promise.withResolvers` 超出本 lab 的 ES2022 声明库，已改为普通 Promise；finally 内直接 throw 改为调用清理函数，保留关闭失败时目录不删除的语义。

## 真实模型与进程

运行 `pnpm exec node --env-file=<ignored .env> --import tsx examples/pool.ts`，模型 `deepseek-flash`。每个 slot 使用独立 workspace、HOME、dshHome，只传启动和模型所需环境；不打印凭据。四个请求接纳后的快照为 `capacity=2, active=2, queued=2, available=0, quarantined=0`；额外第五个请求收到容量错误。

| 请求与精确回复 | slot | generation | session ID | 终态 / 工具 |
| --- | --- | --- | --- | --- |
| `POOL_A` | 1 | 1 | `session-5bfd2e8db3da45f38a067d085cb86bbd` | completed / 0 |
| `POOL_B` | 2 | 1 | `session-4e979b5fc5514f9a90f9a576b5ab05be` | completed / 0 |
| `POOL_C` | 2 | 1 | `session-c91066060e704afb9dc42c31f665dddd` | completed / 0 |
| `POOL_D` | 1 | 1 | `session-8335d8dbe7c3467b8c93c36efce05e20` | completed / 0 |

四条均检查 trimmed finalResponse 精确相等、最后根 `turn/end.kind=completed`、无 `tool/call` 和 session ID 不重复。C/D 复用空闲进程但新建 Session。池关闭后 `state=closed, active=0, queued=0`，两个 slot 均 closed，临时目录已删除。

外部 Python 观察器每 200 ms 采样 `ps` 父子关系：最多同时观察到 5 个后代进程，其中 2 个命令包含 DSH profile 启动参数；观察 PID 为 `87877, 87878, 87905, 87907, 87908`。父命令退出码 0，退出后仍存在的已观察 PID 为 0。采样无法覆盖短于采样间隔的进程，也不证明任意脱离父子树的工具后代可回收；本次没有调用工具。

原始本机记录保存在被忽略的 `.superpowers/sdd/2026-09-29-runtime-pool/real-run.log` 与 `processes.json`。可控故障和真实四请求结果分别记录，真实批次未注入 transport/close 失败，也没有自动重试。

## 范围与后续

本课证明本机两进程可接收有界排队工作并回收，以及可控故障下的调度规则；不保证提供商内部同时推理、吞吐提升、生产公平性或跨平台清理。slot 和目录隔离不是安全隔离，队列不持久化，没有租户配额、业务幂等存储或多轮会话亲和性。

Phase 7.2 可进入已完成状态。下一单元为 7.3 身份认证与租户，仍需在服务层独立实现和验证。旧 compaction/workflow/child resume 等运行覆盖缺口继续保留在[工程化路线](../learning-paths/engineering.md)。
