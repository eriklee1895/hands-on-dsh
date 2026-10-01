# Workflow/PTC 与 child 森林恢复验收

日期：2026-10-02。范围只含 [workflow-child-lifecycle Lab](../../labs/workflow-child-lifecycle/README.md) 及其[进阶章节](../../labs/workflow-child-lifecycle/RECOVERY.md)。发布包固定 `0.1.7-rc.2` / Cordis `4.0.4`；对照上游 `dsh-v0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443` 的 workflow-ptc、Node PTC、subagent continuation、V3→V4 catalog 和 JSONL persistence 代码，未修改上游。

## 已执行的受控路径

| 路径 | 观察到的实际结果 |
| --- | --- |
| PTC 真实进程故障 | 发布版 Node PTC 写入带自身 PID 的 marker 后收到 `SIGKILL`；marker 原始字节与预期 JSON 相等，测试进程与 PTC PID 不同，PTC 已退出，后续完成文件不存在。Workflow `stopReason: error`、`value: null`、`agentsStarted: 0`；marker 的部分文件效果仍存在。 |
| 并发与上限 | 发布版 `parallel()` 的两个 child 同时进入受控模型 gate，峰值并发 `2`；总调用上限为 `2`，第三次 `agent()` 失败，模型请求仍为两次，Workflow 不报告完成。 |
| 脚本显式重试 | 首个 child 的模型 stream 确定性失败并记录 `failed`；脚本收到 `null` 后仅启动第二个 child，第二个 `completed`，调用总数和模型请求均为两次。此结果不代表工具副作用可自动重试。 |
| 正常关闭森林 | 第一个独立 Node worker 创建 `parent → child → grandchild`，等待两个 child 完成并 flush 后正常 dispose。第二个进程、新 Context 先冷列两条直接父子边，再从原父向 child、原 child 向 grandchild 送消息；旧事件前缀逐项相同，grandchild 两个 turn/end 都是 `completed`。 |
| 崩溃森林 | 第一个 worker 在同样的 flush 屏障后保持父 handle；测试进程对其实际 PID 发 `SIGKILL` 并观察退出 signal。新进程完成相同的冷列与继续流程，PID 与原 worker 不同。 |
| 历史 catalog | 三份固定**手写合成 V3** parent/child/grandchild 文件由发布版 JSONL backend `read` 后产生逻辑 V4 目录项；`write` 分别发布 V4 successor。新 backend 重开后事件和父子关系相同；三个 V3 predecessor 与三个 V4 successor 的字节在相应前后检查中不变。 |

森林验证器拒绝缺失 child catalog、错误 header 直接父、错误 label、额外 descriptor、截断历史和额外执行事件。缺失 catalog 与错误直接父的负对照把**前后两份**日志一起改坏，分别命中对应关系校验，而非依赖前后日志不相等。把合成 grandchild 的历史 `parentSession` 改成陌生 ID 后，迁移器未给 child 虚构这个 grandchild 的 catalog。测试只使用实验自己创建的临时 root、进程和文件；没有读取用户 Session、凭据或上游工作树数据。

## 负证据与边界

最初在模型 gate 放行后立即调用 `drainContinuableDescendants()`，读取到 child 的 `turn/end: aborted`，尽管清理正常返回；因此 worker 改为先等待 child 从 registry 释放，检查所有结束原因，再调用 drain。PTC 的 marker 证明的是故障前部分文件效果，不是脚本完成。森林 crash 发生在明确 `flush()` **之后**，所以本次不能断言中途未提交 turn、半写入 frame、恢复时自动重放工具、外部 provider 或失去外部 side effect 确认后的恰好一次语义。历史 V3 数据为合成样本；它验证该固定组合及发布版迁移路径，不代表任意旧日志。真实 Bash 文件任务及其 SHA/字节检查仍由[先前正常关闭实验](2026-09-30-workflow-child.md)单独拥有。

## 本次门禁

从 `labs/workflow-child-lifecycle` 执行 `pnpm test`：5 个测试文件、18 项通过；其中新增真实 PTC/进程森林、历史 catalog，以及真实 Node inspector 提前失败/挂起后的有界清理测试。`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 均通过。测试前观察过验证器缺失、错误 label、额外 descriptor 和错误直接父诊断的明确失败，再补最小验证逻辑。命令与结果只覆盖本 Lab，不等同仓库全量检查。

最终独立复核确认两处P2已修正：目录/直接父负对照不再依赖通用前后差异；seed与inspect进程有有界等待、失败清理及回收确认。修正后的聚焦8项通过，完整Lab18项和静态/build检查通过，无剩余P1/P2。
