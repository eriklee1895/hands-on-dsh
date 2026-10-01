# Compaction：并发维护、部分提交与持久化确认失败

固定 npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。本课回答：manual compaction 的Promise失败后，是否能认为摘要没有生效？答案必须依据日志与存储判断。以下实验使用真实engine、AgentLoop、Session与JSONL；摘要为controlled adapter，故障注入在本次Session的公开append/flush调用处，不制造磁盘损坏或全机故障。

## 运行

在 `labs/compaction-lifecycle`：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm transactions
```

`transactions` 编译fixture plugin，再分别启动4个公开 `sdk-minimal` profile。每个有独立home/workspace，未传API Key，外部模型请求为0。父进程等待报告、关闭owner，再用新Context重开V4，比较全部事件指纹与surface；不是仅看event数量相等。

## 四个场景

| 场景                   | 注入/竞争                                                     | 调用结果                   | 日志与后续行为                                                        |
| ---------------------- | ------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| concurrent-maintenance | 第一份摘要等待；第二次compactNow与followup竞争                | 第二次维护busy；第一份成功 | 后续输入等待摘要及flush gate释放后才进入下一轮，摘要只执行1次         |
| flush-before           | manual bracket已写入后，在调用真实flush前抛异常               | persistence错误            | 内存checkpoint已存在；恢复正常flush并明确核对后，下一轮使用checkpoint |
| flush-after            | 实际flush并通过reader读回完整事件后，抛确认异常               | persistence错误            | 抛错前checkpoint已可读；失败不代表撤销已提交内容                      |
| closing-marker         | summary和replacement写入后，第一次compaction/end append抛异常 | commit错误                 | checkpoint存在但start未闭合；同owner再次压缩被busy拒绝                |

在并发案例中，实验先保持summary gate，再单独保持flush gate；跟进消息已入Inbox，但在checkpoint确认挂起时仍没有新的turn/start或对话模型调用。释放后，新请求包含checkpoint与跟进输入，不含旧长历史。外部Agent status为idle也不能替代maintenance占用判断。

`flush-before` 不能证明磁盘上一定没有新数据：后台写入可能已发生。因此本课只断言当时没有完成本次显式flush，并在恢复原方法后主动reconcile，再检查完整重读。`flush-after` 多做了抛错前的独立reader读取，直接展示“调用失败而数据已提交”的情况。

结束标记故障不是整段rollback：原事件前缀、summary与replacement均保留。实验不会偷偷补一个end然后宣称原操作成功；原owner的重复压缩被拒绝，关闭后读取的日志仍保留未闭合标记。它没有测试通过重启自动修复后再次压缩。

## 源码与验收

[compactSurfaceRegion](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/region.ts)依次记录start、summary、replacement、end，之后才做manual durability checkpoint。失败的closing append留下可识别的未闭合start；flush失败另报 `ManualCompactionError('persistence')`。这些append不能视作数据库的原子transaction。

[compactNow](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-basic/src/index.ts)通过Agent的runMaintenance持有新轮次admission；[driver](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/agent.ts)允许跟进输入排队，但不会把它当成另一个同时运行的维护owner。

[`transaction-scenarios.ts`](src/transaction-scenarios.ts)检查精确异常类/code/cause、只执行一次摘要、surface replaceGeneration增加1、checkpoint内容、不可变原始前缀及下一次模型输入。36项Lab测试中新增4个真实库场景；4个独立profile又分别验证关闭后的完整持久重读。2026-10-02事件数为25/25/25/15，4个记录的runtime PID在结束后均不存在。详情见[元数据](evidence/2026-10-02-transactions.json)与[验收](../../docs/reviews/2026-10-02-compaction-transactions.md)。

## 对调用方的要求

失败后先检查实际记录与持久状态，再决定后续操作；不要仅凭Promise rejected就重发摘要或工具任务。已有checkpoint可能有效，未闭合bracket也可能需要受控恢复。实验中的显式reconcile只恢复本次fixture注入，不是供任意损坏日志使用的修复器。

本课没有验证真实ENOSPC/EIO、物理掉电、恶意并发写者、任意selected-span修改或跨主机存储。真实服务端overflow另见[上一课](PROVIDER-OVERFLOW.md)，其错误来源与这里的公开调用处注入不同。
