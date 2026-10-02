# Compaction overflow 与取消验收

日期：2026-09-30。基线 `7fd2dc1`，扩展 [Compaction Lab](../../labs/compaction-lifecycle/RECOVERY.md)。固定 npm `0.1.7-rc.2`、Cordis `4.0.4`、源码 `477b4f420553e8a52c2fbccc464d7561b239c443`；macOS arm64、Node `26.7.0`、pnpm `12.3.4`。

## 证据分类

本批是**受控 adapter 的故障注入**，不是供应商真实 overflow。组件测试挂真实 AgentLoop/Compaction/JSONL；独立进程测试通过公开 sdk-minimal profile 加编译的课程 plugin 跑相同场景。子进程环境不传 API Key，外部模型请求为0。既有真实 pressure 摘要见[前批记录](2026-09-30-compaction.md)，没有为本批重复调用。

| 场景 | 故障对话/摘要请求 | replacement 增量 | 最终终态 | 持久事件 |
| --- | --- | ---: | --- | ---: |
| thrown overflow 恢复 | 2 / 1 | 1 | completed | 26 |
| in-band overflow 恢复 | 2 / 1 | 1 | completed | 26 |
| 重试预算耗尽 | 2 / 1 | 1 | error | 26 |
| overflow recovery 禁用 | 1 / 0 | 0 | error | 20 |
| 摘要不缩小 | 1 / 1 | 0 | error | 22 |
| 摘要失败 | 1 / 1 | 0 | error | 22 |
| 非标准错误 | 1 / 0 | 0 | error | 20 |
| 手动取消，adapter 迟到返回 | 0 / 1 | 0 | maintenance 拒绝；后续 turn completed | 22 |
| 自动取消，adapter 响应信号 | 1 / 1 | 0 | aborted / user | 22 |
| 自动取消，adapter 迟到返回 | 1 / 1 | 1 | aborted / user，无对话重试 | 24 |

对话请求计数排除准备历史和手动取消后的验证请求。每个成功恢复要求 compaction 位于同一个 step 内，重试请求改用 checkpoint 并保留当前输入。失败恢复保留标准 overflow 的 code/message。manual 取消后的新 message 被记录并到达 adapter，第二个 turn completed。

## 版本边界与复核修正

初始预期“自动取消总是不提交摘要”被受控测试否定。核对固定源码发现，摘要返回后的取消检查在 transaction 中只对 manual owner 执行；自动 listener 会阻止取消后的 retry，但非合作 adapter 的迟到摘要可能已提交。新增独立 `overflow-late-summary` 案例保留这个实际观察，不修改 upstream，也不把 checkpoint 当作根 turn 成功。

独立 review 指出最初 persistence 检查只比较节点偏移，无法拒绝内容被改变的 checkpoint。补了保持 seq/nodes 不变的内容篡改负对照，观察 RED/GREEN，并改为稳定对象键排序后的完整事件指纹；同时加强 manual 后续 message/adapter/turn2 与原错误 message 检查。

首次10个 profile 完成节点比较；扩展后的第一次复跑因旧 dist 不含新指纹而被验收拒绝，目录保留、4个采样 PID 退出。原因是测试中的 readonly 赋值令 typecheck 阻止 build；修正 fixture 并确认 build 通过后，最终完整重跑10个 profile。没有外部模型调用或自动任务重放。

## 最终验证

| 检查 | 结果 |
| --- | --- |
| Lab tests | 17项通过，包含10种新故障场景与内容篡改负对照 |
| typecheck / build | 通过 |
| 独立 profile | 10/10通过，退出后公开 backend 重读 V4 |
| 持久一致性 | 全部事件指纹、事件数量、marker 与 surface nodes 一致 |
| 进程观察 | 200ms采样，峰值3后代；记录12个PID，结束后残留0 |
| lint / format / frozen install | 通过 |
| 文档检查 | 9 篇变动 Markdown、109 个相对链接、3 个 Mermaid 图表通过 |
| 暂存 diff / credentials | diff 检查通过；17 个文件的凭据模式与个人绝对路径命中均为0 |
| 独立复核 | P2重放证据问题已修正；最终代码、表格、数据与取消语义复核无剩余 P1/P2 |

最终10个 runtime PID：`19626, 19629, 19637, 19639, 19642, 19657, 19693, 19696, 19699, 19701`。成功的临时目录在所有 owner 关闭、读取验证结束后删除；失败路径保留状态。安全元数据和各日志指纹见[结果 JSON](../../labs/compaction-lifecycle/evidence/2026-09-30-recovery.json)。

## 范围限制

未验证实际供应商 overflow、真实网络取消及时性、prune/image-offload、surface 并发、持久化失败、强杀恢复、transient retry 混合及预算重置、通用摘要质量或费用。取消的权威终态与已经提交的 surface 变化必须分别报告；此版迟到摘要行为不是跨版本保证。
