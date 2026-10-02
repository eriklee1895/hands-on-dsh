# Phase 7.5：Run 观测、重放与费用估算验收

2026-09-29 完成 [run-observability lab](../../labs/run-observability/README.md)。新增白名单事件投影、带冲突检查的去重账本、单进程快照重载和显式教学费率估算。它统计已观测的 assistant settlement，不访问供应商账单，不执行扣费，不改写原始 Session 日志。

基线 `4cc945b`。沿用 npm SDK/runtime `0.1.7-rc.2`、Cordis `4.0.4`；Node `26.7.0`、pnpm `12.3.4`、macOS arm64。工具链依赖与 runtime-supervision lab 一致，独立子项目拥有自己的 lockfile。设计见[spec](../superpowers/specs/2026-09-29-run-observability-design.md)，执行项见[plan](../superpowers/plans/2026-09-29-run-observability.md)。

## 固定源码事实

审查 revision 为 `dsh-v0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`。

- [SessionEvent](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/types.ts)使用 session 内 seq；assistant/message 和 assistant/attempt 是 durable settlement，step/end 不含 usage。
- [BlockAssembler](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm/src/assembler.ts)替换每个 usage sample；同一 attempt 多次 usage 取最后值，不能累加。scalar 与 stream 不能计两份。
- [TokenUsage](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm/src/types.ts)将 uncached input、cache read/write 分开；reasoning 是 output 内的细分，总量与 reasoning 都不另加。
- [Retry 事件](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-retry/src/types.ts)区分 scheduled 与 started，retryId 不能代替供应商 billable request ID。
- [SDK 高层 API](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/api.ts)返回本次 receipt-to-idle 区间的根 session 事件；不是完整 session/tree 的计费清单。

源码还提供 [deriveTurnTokenUsage](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/token-meter/src/turn-usage.ts)进行保守的完整 turn 汇总。本课的独立观测账本承担跨 Run 绑定、去重、白名单快照与教学费率演算，不把不完整区间冒充该 helper 的完整 turn 结果。compaction/title 等辅助调用的覆盖缺口见教程。

## 本地检查与虚构重放

以下命令在 `labs/run-observability` 执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 2 files，16 tests 通过 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过，无 warning |
| `pnpm format:check` | 通过 |
| `pnpm install --frozen-lockfile` | 通过，lockfile 未变 |
| `pnpm demo` | 虚构两 Run，保存重载后忽略 15 个重复事件；摘要完全相同 |

测试覆盖 payload 白名单、未知事件、scalar/stream 单次统计、attempt stream-only、缺失 usage、可选字段缺失、重试标记、乱序与冲突、重叠 Run 区间拒绝、BigInt、路由/费率匹配、有限 finish 类别和持久快照严格 schema。无效数字、错误 total、畸形 stream 不会默默当作零；snapshot 错误不回显输入片段。

虚构 Run A 的两个 settlement 共报告 uncached input 30、output 6、cache read 13、cache write 0、reasoning 3；按教学费率计算 `43300` nanoUSD。失败 attempt 的早期 usage sample 被最后 sample 替代，成功 message 的 scalar 与 stream 没有重复加。一个 compaction 标记被明确排除。

虚构 Run B 没有 usage，`missingUsage=1`。它的已报告用量估算为 `0`，不是已证实的零成本。两 Run 共用同一 source/session，不共用 runId；checkpoint 中的私人文本标记不存在。

文档检查：1 个 Mermaid 图通过 Mermaid 11.16.0 解析，变更文档的 60 个本地文件链接均存在，`git diff --check` 通过。

## 真实双 Run 与快照重放

仅执行一次真实脚本：`pnpm exec node --env-file=<ignored .env> --import tsx examples/live.ts`。它在同一 Session 内顺序提交两条独立请求，均精确回复私有 nonce、根 turn completed、工具调用为 0。没有自动重试，没有注入真实 provider retry。

共同 source 为 `source-2af26009-f190-4c44-883a-b42e8742516b`，Session 为 `session-4087d10e-3fb5-4fa2-855b-2f4aa9772e1e`。

| Run | turn/end seq | 已结算 attempts | input / output | cache read / write | 教学估算 nanoUSD |
| --- | --- | --- | --- | --- | --- |
| `run-d1fb4232-2ba7-45b4-a22f-3027432fe933` | turn 1 / seq 12 | 1 | 79 / 46 | 0 / 0 | 171000 |
| `run-fe6184c6-7d97-4dbb-911d-9d28698de4bf` | turn 2 / seq 21 | 1 | 147 / 64 | 0 / 0 | 275000 |

两 Run 均 `missingUsage=0`，但各有 1 次未报告 reasoning 细分，不能把 `totals.reasoningTokens="0"` 解释为实际没有推理用量。没有观察到 retry 或辅助调用标记；这不证明区间外没有这些活动。

写入快照、重新加载后，再次导入全部 22 条事件，全部识别为重复；两个摘要与重载前深度相等。保存内容不含 prompt/reply 的两个随机标记或 API key。导出只包含白名单元数据；原始 SDK 事件没有保存到观测文件。

费率为 `teaching-v1-not-provider-prices`：input/output/cache read/cache write 分别是 1000/2000/100/1200 nanoUSD per token。表内金额只是这组演示费率下的已报告部分估算，不是 DeepSeek 实际价格或扣费。

外部 `ps` 每 200 ms 采样，观察到后代 PID `95178, 95182, 95187, 95235`，峰值同时 4 个；脚本退出码 0，退出后已观察 PID 全部不存在。成功 close 后临时目录被删除。采样不覆盖任意脱离父子树的进程。安全摘要与采样保存在被忽略的 `.superpowers/sdd/2026-09-29-run-observability/real-run.log`、`processes.json`；虚构示例另存 `synthetic.log`。

## Review 与后续

代码 review 发现不完整 cache 分类下的 total 校验缺口：total 仍必须不小于所有已报告的不重叠计数之和；两类 cache 都报告时则必须精确相等。修复后独立复现的两种矛盾输入均被拒绝，账本仍为空；16 项测试通过，无待修项。模型调用在最终修复后执行。

本课完成 Run 元数据观测和可重放估算。Binding 标识由可信业务方提供；观测快照不是认证数据库、账单或防篡改审计系统。标题、失败辅助调用、未结算请求、实际供应商价格/调整，以及未包含的子 Session 都需要另行采集和核对。下一课为 [7.6 Eval 与可重放回归](../learning-paths/engineering.md)，7.4 容器/远程执行仍保留为待扩展。
