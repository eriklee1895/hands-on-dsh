# Compaction并发与持久化失败验收

2026-10-02；固定npm0.1.7-rc.2/upstream477b4f420553e8a52c2fbccc464d7561b239c443，macOS arm64/Node26.7.0/pnpm12.3.4。[章节](../../labs/compaction-lifecycle/TRANSACTIONS.md)使用真实发布engine、loop、Session、JSONL，模型与故障为受控fixture，外部API请求0。

| 场景 | caller错误 | compaction标记 | 事件数 | 额外断言 |
| --- | --- | --- | ---: | --- |
| 并发维护 | 第二owner busy | start/summary/end | 25 | followup等待summary与flush双gate，1次摘要 |
| flush前故障 | persistence | start/summary/end | 25 | checkpoint已在内存，明确reconcile后继续 |
| flush后确认故障 | persistence | start/summary/end | 25 | 抛错前实际reader已读回完整事件 |
| end append故障 | commit | start/summary | 15 | checkpoint保留，同owner重试busy |

四例原始前缀完全一致，replacement generation增加1、0工具调用。前三例后续对话使用checkpoint；最后一例保留未闭合标记，不补写成功end。每例在独立sdk-minimal进程执行，关闭后新Context重开V4，全部事件fingerprint与surface相同，记录PID均不存在。数据见[JSON](../../labs/compaction-lifecycle/evidence/2026-10-02-transactions.json)。

TDD从4个Not implemented失败开始；实现后4项通过，Lab整体36项通过，类型/lint通过。新增抛错前存储读取与flush等待断言后，重新跑了4项和4个profile；没有外部模型调用。最终36项测试、类型/lint/format/build、frozen install通过；独立review无P1/P2，确认方法恢复、双gate清理、异常分类与持久证据范围。

这些故障注入在公开的Session append或sessions.flush方法，未改变上游安装包。它们验证调用方与compaction的失败语义，不是物理磁盘或网络故障演练；flush-before不声称后台未写入，flush-after有抛错前的独立读取证据。PID确认只覆盖报告中的4个runtime，不是全系统进程审计。
