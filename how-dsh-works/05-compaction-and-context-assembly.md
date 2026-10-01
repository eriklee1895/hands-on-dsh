# Compaction 与 Context Assembly：从日志重建模型请求

> 固定版本：`dsh-v0.1.7-rc.2`；revision：`477b4f420553e8a52c2fbccc464d7561b239c443`；源码审查：2026-09-29。

上下文压缩改变模型可见的 surface，不删原始事实。动态 runtime context、system prompt 和摘要 checkpoint 各有来源，不能因为最后都是 Message 就合并解释。

## Verified from source

| 入口 | 职责 |
| --- | --- |
| [Agent driver](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/agent.ts) | assembly、prepared call、system admission 和 request series |
| [SystemPrompt](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/system-prompt/src/index.ts) | scoped sections、contexts、tools 与 variables |
| [Runtime context](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/runtime-context.ts) | 当前完整快照去重、清除与恢复 |
| [Compaction engine](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/index.ts) | pressure hook、overflow retry、manual maintenance |
| [Region transaction](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/region.ts)、[summarizer](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/summarizer.ts) | 稳定范围、bracket、summary 与替换 |

### 本步 assembly 与每次 attempt

claim 后用 `assembleContextFor(agent, signal)` 汇总 sections、contexts、tools 和 variables。scoped contribution 影响当前 Agent；`system-prompt/assemble` 与 `agent/pre-step` 都是 cooperative waterfall，包装 listener 要委托 next。runtime context 渲染为完整快照，只有相对当前 retained surface 改变时才提出新 user message；其 `source.kind` 是 `runtime-context`，不是旧的 plugin-name 判定。

`agent/request` 与 `prepareCall()` 解析实际 route 后才协调 system/users。system prompt 是 surface 中的 `system/message`，**不再是 `request/header.system`**。prepared route 支持 in-history update 时可在同一 series 后面追加非空新 prompt；不支持或开始新 series 时归并到首个 system 节点。清空时必须用日志中的空 replacement 清除全部活跃 system 节点，不能使旧内容重新显现。

`request/header` 保存非历史 envelope：config、tools 和 adapterDefaults 等。reason 包括 initial、resume、change、series；surface content generation 改变或显式 `startsRequestSeries` 可建立新 series，envelope 同时改变则带 startsSeries。`request/context` 记录模型容量等元数据，不能用之前的容量快照代替当前 prepared capability。

```mermaid
flowchart TD
    A["claim + scoped assembly"] --> B["runtime-context snapshot"]
    B --> C["agent/pre-step / compaction"]
    C --> D["resolve request + prepareCall"]
    D --> E["log system and admitted users"]
    E --> H["header / context / series"]
    H --> F["derive surface messages and freeze"]
    F --> G["stream prepared call"]
    G -->|"overflow + durable reduction"| D
```

### 压缩是 plugin 行为

automatic compaction 监听 agent/pre-step 的压力检查，以及 agent/request-error 的 context overflow。overflow retry 需要 durable surface replacement 前进且未取消，并受 retry cap 限制；如果 model-free prune 已产生有效缩减，后续可选 summary 失败仍可能允许重试。重试同一步不重新 assembly 或领取 inbox。

选区按 surface 顺序保留近期 tail，避免拆开工具调用与结果；summary 前后检查所选范围仍有效。事务为 compaction/start → summarize → compaction/summary → replacement user/message → compaction/end。checkpoint 的 replacement 使用 startSeq/endSeq，sourceEventSeqs 引用 opening marker、summary 与被覆盖节点。旧 events 保留。自动流程检查 whole surface，manual compactNow 通过 runMaintenance 占据 idle admission，并按其选区稳定规则执行。

summarizer 直接调用 LLM service，purpose 为 compaction；输入以派生 system head 和按 surface 顺序选出的消息为基础，工具 schema 用于请求前缀，末尾追加摘要指令。它不是另起一轮 AgentLoop。summary、checkpoint 和 closing event 使结果可重放，但不能把多次 append 当作数据库原子事务；失败的 closing marker 可能留下可识别的未闭合 compaction。

## Observed at runtime

2026-09-29 的 published-core probe 使用真实发布库、确定性 adapter：

```sh
node --test --test-name-pattern='runtime context|inbox waits' how-dsh-works/probes/published-core.test.mjs
```

上述 probe 完整 3/3 passed，覆盖相同 context 在连续两轮只记一次、变化后新增 runtime-context 快照、system prompt 出现在已记录 history。该 probe 本身不调用 compaction engine 或 summarizer。

2026-09-30 新增 [compaction-lifecycle lab](../labs/compaction-lifecycle/README.md)：基础批次的7个 keyless tests 执行发布的 compaction engine，覆盖 manual no-op、成功 bracket/replacement、失败不提交、后续请求和 automatic pressure，以及验收器的反例。

真实 sdk-minimal 显式挂 meter/compaction 插件，将触发比率调低后完成一次成功的 pressure compaction。旧 seed seq 5 进入 shadowedSeqs，checkpoint seq 19 仍含随机 code，end seq 20 早于产物 step/start seq 21；当时其余保留消息不含 code。模型随后一次 Bash 写出精确 40 字节产物。关闭后通过新 public persistence backend 读回 34 个事件，原始前缀和 surface 重放验证通过。

首次实跑的 1024-token 摘要预算出现截断，未提交 checkpoint，原始上下文仍可继续任务；提高预算至 4096 后使用全新 fixture 获得以上成功结果。命令、hash、usage、失败与成功分开的证据见[执行记录](../docs/reviews/2026-09-30-compaction.md)。这不是 `/compact` 的 SDK RPC，也不是 SDK 冷恢复：manual 由库级测试验证，live 通过 pre-step pressure 触发。

[溢出与取消实验](../labs/compaction-lifecycle/RECOVERY.md)另增10种 controlled adapter 场景，该批次 Lab 合计17项测试；每个场景还经独立 sdk-minimal profile 执行并重开 V4，完整事件指纹和 surface 一致。覆盖 thrown/in-band 标准溢出、零重试/预算耗尽、无进展/摘要失败、非标准错误与取消。故障输入来自 fixture，不是真实供应商 overflow。

该固定版的重要观察：手动取消会拒绝迟到摘要，正常响应取消的自动摘要也不提交；但自动摘要若忽略 signal 并迟到返回有效结果，可以先提交 checkpoint，随后 listener 仍因取消拒绝 retry，turn 以 aborted/user 结束。不能由 turn 取消推断 surface 未变化。详见[验收](../docs/reviews/2026-09-30-compaction-recovery.md)。

[裁剪与图片 offload](../labs/compaction-lifecycle/REDUCTION.md)将 Lab 扩展到29项测试，并完成旧10个和新10个独立 profile 验证。裁剪追加 replacement；offload 只记录 occurrence 选择，节点编号可保持不变。大 route 不会自动撤销旧选择，同附件的新 occurrence 可以仍是图片。已提交的 prune/offload 在后续摘要失败或取消后保留。

这一批同时比较原始事件、模型适配器的占位符视图、显式 image projection 的重放与真实70字节 PNG 文件；没有调用外部视觉模型或生产附件 store。缺失 projection、重复图片索引、交换合法索引，以及 live pruner 改动图片字段/位置的负对照均可拒绝，详见[验收](../docs/reviews/2026-09-30-compaction-reduction.md)。

[附件输入 Lab](../labs/attachment-input/README.md)另行验证了生产 store 的接纳/归一化、两张随机图片的真实 Files 传输与关闭后独立重读；[fallback课](../labs/attachment-input/FALLBACK.md)补上受控Files失败后的整请求真实inline传输；这不扩大上述 offload fixture 的证据范围，其中[本地provider图片预算](../labs/attachment-input/BUDGET.md)与[已删除Files引用](../labs/attachment-input/STALE.md)分别有独立运行证据；[服务端overflow课](../labs/compaction-lifecycle/PROVIDER-OVERFLOW.md)另以单次长输入观察到真实400/CONTEXT_WINDOW_EXCEEDED、0工具和12个持久事件。

[事务与并发维护课](../labs/compaction-lifecycle/TRANSACTIONS.md)补充4个独立profile：第二维护owner被拒绝、followup等待flush、flush前/后注入失败、end append失败。失败调用可能已有checkpoint；未闭合标记会阻止同owner再次压缩。36项测试与各自持久重读不能扩大为真实磁盘故障保证。

## Inference、Proposal 与未确认

Inference：Request Inspector 应并排显示 header、system/developer messages、surface 顺序和 compaction bracket；仅打印全 log 会把 shadowed 内容误作当前请求。Proposal：后续可补真实物理存储故障与更广摘要质量实验。本次已验证基本压缩事务和一个随机 code 的真实保留，尚未证明一般摘要质量、provider cache 性能或完整成本；[旧 45 项测试](historical-2026-08-31.md)保留为 2026-08-31 历史结果。
