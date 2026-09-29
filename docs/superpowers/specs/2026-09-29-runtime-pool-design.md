# Phase 7.2：有界 runtime 池

## 目标与范围

在 `labs/runtime-supervision` 的 RuntimeSupervisor 上增加独立请求池，学习容量、排队和资源所有权。固定既有 npm DSH `0.1.7-rc.2`。不把池接入已有多轮 Conversation 应用，不新增数据库、认证或跨进程分布式队列。

每个 slot 懒创建一个独立 SDK owner，串行使用，workspace/HOME/DSH_HOME 独立。池自动管理内部独占使用期，不把可提前 release 的裸 lease 暴露给调用方；一个请求的 supervisor.run 完全结算后才能重新分配 slot。

## 接口

`RuntimePool(factory, options)`：factory `(slotId: number) => OwnedRuntime`，slotId 为稳定的 1..size。options 包含 size（1..32）、maxQueued（0..1024）、activityTimeoutMs 和 queueTimeoutMs（正整数且不超过 2147483647）。这些是本课明确的容量上限，不构成通用生产配置标准。

`run(prompt, { queueSignal? } = {})` 返回 `Promise<PoolRunResult>`，其中 `{ slotId, generation, result: RunResult }` 保留 SDK 结果。generation 是该 slot 的 owner 构造次数，不是 durable runtime ID；Promise resolve 不等于模型成功。调用方需读 turn/end。

`snapshot()` 返回独立的状态副本：state（open/closing/closed/close-failed）、capacity、active、queued、available、quarantined，以及 slots 的 slotId/state/generation/leased。available 只数可立即使用的健康空闲 slot，active 包含工作后的回收等待。

`close()` 返回一个共享 promise：立即停止新 admission，拒绝仍在队列的请求；等待 active 请求结算后逐 slot 关闭。成功后 state=closed；任一 close 失败聚合所有回收错误并保持 close-failed，不重新打开或偷偷创建替代进程。重复 close 共享同一次结果。

错误类：PoolCapacityError、PoolQueueTimeoutError、PoolQueueAbortedError、PoolClosedError、PoolUnavailableError、PoolOwnerReuseError。关闭错误可使用带 slot 标识的 AggregateError。

## 调度和故障

- 空闲 slot 立即接收；其他请求进入有界 FIFO。maxQueued=0 表示只接受立即可运行的请求。后来请求不能越过已排队的请求。
- queueSignal 只在等待分配时有效。已 aborted 的请求不创建 owner；dispatch 后移除 listener，signal 不取消已运行的 SDK 工作。名称和文档明确这一点，不伪装成 wire cancel。
- queue timeout 从排队时开始，activity timeout 从 dispatch 后由现有 supervisor 管理。队列保存单调 deadline，dispatch 前再次检查，不能仅依赖延迟触发的 timer。移出队列时清除 timer/listener。
- 普通运行失败/超时：由 supervisor 回收，错误交还原请求；关闭确认后可以分配其他已明确提交的请求并创建新 generation。失败 prompt 本身不重放。
- close 失败：该 supervisor 被隔离，池容量减少；其他健康 slot 继续接单。所有 slot 均隔离时立即拒绝待排队/新请求为 unavailable，不让它们无期限等待。
- factory 必须返回新的独占 owner；池用对象身份检查拒绝跨 slot 共享或复用已用过的 owner，不能因为配置错误关闭另一个 slot 正在使用的对象。
- 所有状态变更与 slot 预留在进入异步操作前完成。旧请求的 finally 不得清除新请求的 ownership。

## 实验与证据

Keyless tests 使用受控 promise/fake timers，验证边界容量、FIFO、queue timeout/abort、dispatch 后 signal、timeout 回收、新 generation、隔离降容、全部隔离、重复 close、close 失败、共享 factory 与迟到结果。保留现有 7.1 tests。

`examples/pool-faults.ts` 不读 key，展示两 slot 满载、队列满拒绝、一次模拟 transport failure、不重放与后续新任务；输出每个任务的结果与 slot/generation。

`examples/pool.ts` 使用公开 sdk-minimal、禁用 shell tools 的 profile patch，两个独立 home/workspace，提交四个简单无工具请求并验证 completed、精确文本与零 tool/call。记录 pool 初始 active=2/queued=2，所有任务结束后 close；外部 ps 观察真实并发 runtime 与回收。失败且不能确认关闭时保留临时目录。

新教程 `POOL.md` 解释排队与活动时限、内部独占分配、单 slot 故障与整体关闭，以及它不提供 Conversation affinity、持久排队、租户隔离或业务幂等。真实 SDK 成功路径与 fake 故障证据分开。沿用本地提交授权，不推送。
