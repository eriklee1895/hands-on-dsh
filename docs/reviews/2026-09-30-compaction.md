# Compaction：新版实际运行与持久重放验收

2026-09-30 补齐[机制篇05](../../how-dsh-works/05-compaction-and-context-assembly.md)的基本压缩执行证据，新增[compaction-lifecycle lab](../../labs/compaction-lifecycle/README.md)。基线`3fbbb8d`，固定npm SDK/runtime0.1.7-rc.2、Cordis4.0.4，上游revision`477b4f420553e8a52c2fbccc464d7561b239c443`。本机macOS arm64、Node26.7.0、pnpm12.3.4；未改上游代码。

## 源码与触发范围

sdk-minimal默认不挂compaction；实验增加发布token-meter和compaction-basic入口。保留模型目录W=1,000,000，thresholdRatio0.002、headroom1024、Agent输出cap512，得到2000-token触发阈值。retainTokens=0仍保留末尾节点，避免短READY尾部使整个大user消息被保留而无法选区。配置和公式来自固定[compaction config](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/config.ts)、[region selection](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/region.ts)。

manual测试直接调用公开compactNow，live使用pre-step pressure，未添加SDK私有compact RPC。summary是独立LLM调用，purpose=compaction；在本课的总请求里应与正常Agent步骤分开理解。maxOverflowRetries=0未覆盖overflow恢复；compactionRetries=0只限制每个触发的额外尝试。

## Keyless 与静态检查

从`labs/compaction-lifecycle`执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 7 passed：4个真实engine场景、3个验证器场景 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm format:check` | 通过 |
| `pnpm install --frozen-lockfile` | 通过，lockfile未变 |

engine使用发布Context/Session/AgentLoop/TokenMeter/BasicCompactionEngine，仅LlmAdapter给确定性输出。验证manual empty no-op不写事件、成功bracket/替换/原prefix不变/后续请求使用summary、summary失败无replacement，以及automatic pressure仍保留当前待处理输入。

验收器反例覆盖：没有closing marker、错误shadowed seed、丢失code的checkpoint、压缩发生在proof步骤之后、code藏在保留的非checkpoint消息中。最后三种情况均不能因“summary或最终文件看起来正确”而通过。

文档检查：2个Mermaid图通过Mermaid11.16.0解析，变更文档的84个本地文件链接均存在，`git diff --check`通过。

## 首次真实尝试：摘要截断，未通过

首次summary maxTokens=1024，两个pre-step触发均以`compaction/end.error = summarization truncated at the token cap (incomplete checkpoint)`关闭，没有compaction/summary或replacement。原始上下文保留，后续工具仍写出了正确文件，但实验因缺失成功压缩记录返回1。

这说明artifact正确不足以证明压缩有效，也展示了自动hook失败后继续turn的行为。没有自动重放该任务。其自有状态目录保留用于排查，外部观察到的6个后代PID全部退出；日志/采样以`truncated-summary-`前缀保存在本机忽略目录。

## 新 fixture 的成功真实实验

将summary预算改为4096，创建全新临时目录和随机code，运行`pnpm exec node --env-file=<ignored .env> --import tsx examples/live.ts`。没有在第二轮重新提供code，也没有让模型读取session文件或环境：唯一工具命令必须精确等于只写proof.txt的printf模板。

| 证据 | 观察结果 |
| --- | --- |
| session | `compaction-9c6eebeb-bdf6-43df-bc79-c774c83582d0` |
| compactionId | `dddc57bc-a700-4100-8018-bf4c24b8bb4e` |
| bracket/checkpoint | start16 → summary18 → checkpoint19 → end20，无error |
| 被替换节点 | shadowedSeqs=[5]；estimated shadowedTokenCount=4979 |
| proof位置 | step/start21，tool/call26；压缩先于产生工具调用的请求 |
| code来源 | summary和checkpoint含精确code；当时其他保留消息不含code |
| 当前surface | `[4,19,10,22,25,27,31]`，不含seed5 |
| 原始事实 | seed5与其噪声仍在log，第一轮事件前缀未变 |
| 持久化 | SDK关闭后通过全新公开backend读回34个V4事件，逐seq匹配，surface重放相同 |
| 后续任务 | 根turn completed，恰好一次Bash、call/result匹配、最终DONE |
| 产物 | 精确40bytes，SHA-256 `e0160b4541be9d8fcb2ff55c4006ca5bd253e99e6e48fdb99cce2f985a754bd7` |

summary文本SHA-256为`94f7f2fb995bfd60de571a44215133df519ef698bad2169db2722f5d7a6a6b7d`。summary事件的实际usage为：uncached input487、cache read8704、cache write0、output903、total10094。没有报告reasoning细分，不能当作零。一次cache read数值不证明缓存优化性能；失败摘要和正常Agent调用也不包含在这个单一summary计数里。

外部每200ms采样，观察PID`87311,87312,87313,87315,87436`，峰值同时5个后代；命令退出0，已观察PID关闭后全部不存在。成功验证后自有临时目录删除。采样不覆盖任意脱离父子树的后代。

成功原始元数据保存在被忽略的`.superpowers/sdd/2026-09-30-compaction/real-run.log`与`processes.json`。没有输出或提交API key、seed正文、summary正文或provider原始错误。保留的失败目录仍含原始虚构会话；不是脱敏数据集。

## Review 与尚未验证

独立review发现验收链的两个P2：只检查summary含code，未检查checkpoint；未确认压缩早于proof步骤，且可能从保留的assistant reasoning拿到code。新增反例后修复并独立复核，7项测试通过，无待修问题。成功模型实验在这些修复之后执行。文档复核另外发现close拒绝会跳过保留目录输出，已用嵌套finally修复；无模型的startup/close异常注入确认目录仍在且路径可见、原始错误不输出。这个最后的日志路径修复未重复调用模型，正常成功流程保持不变。

本批完成基本manual/automatic/失败控制与一次真实pressure摘要，不能推导一般摘要质量。provider overflow恢复、取消中途事务、tool-result prune、图片offload、复杂工具配对、压缩历史格式迁移、跨进程Agent继续执行、完整成本与缓存性能仍未验收。下一优先项保持workflow-ptc与child cold resume，未将它们标为完成。
