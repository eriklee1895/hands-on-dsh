# Phase7.7：DSH 双协议适配基础验收

2026-09-30 完成[协议适配层教程](../../labs/protocol-semantics/ADAPTERS.md)，基线 `5ed5e9d`。复用现有 JsonlPeer、SdkProbe、AcpProbe、OwnedState 和公开 dsh launch，没有新增 transport 或依赖。

这里的两个实现均为 DSH 引擎，协议分别为 SDK JSON-RPC 和 ACP。Codex/Hermes 返回 not-integrated，未启动或验证这些产品。工程化路线将 7.7 的基础部分完成与其他引擎未接入分别记录。

## 版本与语义纠正

本机为 macOS arm64，Python3.10.20、Node26.7.0、pnpm12.3.4；npm DSH固定0.1.7-rc.2，源码tag dsh-v0.1.7-rc.2 / `477b4f420553e8a52c2fbccc464d7561b239c443`，ACP JS SDK1.4.0 / protocol v1。wire identity的0.0.1不代替发行版本。

固定源码 [ACP codec](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/acp/acp/src/codec.ts)把completed映射end_turn，也将aborted/blocked映射end_turn；max-tokens映射max_tokens。错误还受[session settlement](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/acp/acp/src/session.ts)的RPC错误处理约束，不能只孤立阅读codec函数。

因此新Adapter把ACP end_turn映射为settled，SDK明确的root completed才映射completed；ACP max_tokens为incomplete。旧ACP transcript里没有依据的turn_end=completed也改为protocol_end/acp/end_turn，增加单独fixture；SDK原有terminal保留。这是纠正两个协议被过度统一的语义，不是改变上游行为。

[SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/server/src/server.ts)公开`initialize`、`session/prompt`、`shutdown`，未提供本课的session close/resume/cancel RPC。[ACP bridge](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/acp/acp/src/index.ts)支持这些扩展，但本Adapter的cancel只提供fake fixture，permission也只保留probe-only范围，默认reject-once。

## 最终本地检查

命令从`labs/protocol-semantics`执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 成功，固定发布包已安装，lockfile未变 |
| `UV_NO_SYNC=1 uv run --offline --python 3.10 pytest tests` | 109 passed |
| `UV_NO_SYNC=1 uv run --offline --python 3.10 ruff check .` | 通过 |
| `UV_NO_SYNC=1 uv run --offline --python 3.10 ruff format --check .` | 28 files通过 |
| `uv lock --offline --check` | 11 packages，lockfile未变 |

新增22项回归：17个adapter用例、3个comparison CLI/评分用例、1个ACP max_tokens用例和1个ACP terminal normalization用例；既有87项保留。覆盖unsupported不发wire、busy/faulted拒绝、取消等待方与结算竞态、并发close、close失败保留状态、有限native字段和不输出原始provider错误。

首轮发布检查在npm安装完成前执行，因缺少本项目的固定包而预检退出2，未启动runtime或调用模型；两个依赖包metadata的旧测试也因此失败。安装完成并格式化后，完整109项通过，随后完成真实对照。此预检失败不算一次模型实验。

文档检查：1个Mermaid图通过Mermaid11.16.0解析，变更文档的68个本地文件链接均存在，`git diff --check`通过。

## 受控共同场景

`python -m protocol_labs.comparison`通过13个场景，engine=dsh、evidence=controlled-peers：

- 两协议各自的正常prompt、timeout、peer EOF和JSON-RPC error，共8项。
- SDK的session-close/resume/cancel三个扩展明确拒绝，不用替代操作伪装支持。
- ACP先生成已提交文本，再session close/resume，确认同一ID且无历史文本重放；另验证readiness后的cancel fixture。

每项都确认group_gone和state_removed。失败场景要求正确的错误类别、may_have_executed=true，以及faulted后拒绝复用；“场景通过”不意味着远端任务成功。

负对照只将首个exact_text检查改为false，实际退出1，passed12/failed1。恢复场景增加“已有已提交文本”的前置检查后，CLI正例与负对照重新通过；没有因此追加模型调用。

## 真实同任务双 profile

使用本项目公开dsh CLI分别启动sdk-minimal和acp，运行一次`--server package`批次，共两条prompt。两个入口收到同一个随机nonce回复任务，并要求不调用工具。

| 检查 | SDK JSON-RPC | ACP |
| --- | --- | --- |
| 任务文本精确匹配 | true | true |
| 回复SHA-256 | `9062a91d8c7d4f61c5454b309cbc385fdd998e7bd1694aaad555eeee6ccc04bc` | 相同 |
| 原生结算 | receipt matched、root turn completed、root idle | stopReason=end_turn |
| 业务根终态证据 | completedTurnObserved=true | 无等价证据，不推断root completed |
| 工具事件 | 0 root tool/call | 0 tool_call/tool_call_update |
| 关闭 | code0，无信号升级，group gone | code0，无信号升级，group gone |
| 临时状态 | 已删除 | 已删除 |

CLI结果selected2/passed2/failed0，故障、cancel和resume明确列为not_run。两种非零tool_events计数不是同一口径，本次只用它们确认零工具。

外部ps每200ms采样，累计观察PID `170,171,272`，峰值同时2个后代、1个DSH profile进程；父命令退出0，已观察PID退出后全部不存在。它不覆盖任意脱离父子树的进程，也不证明进程或workspace构成安全隔离。

本机忽略目录`.superpowers/sdd/2026-09-30-runtime-adapters/`保存`fake-final.json`、`negative.json`、`real-run.log`和`processes.json`，首次预检失败单独保留preflight前缀。真实prompt/reply本身没有写进comparison输出，只保存匹配布尔和hash。

## Review与范围

独立review发现一个P2：owned task刚结算时取消等待方，done callback可能先把adapter设为open，导致被取消的调用之后还能复用。修复后open/busy均会因该取消转为faulted，且不覆盖closing/closed；原复现现在在发出下一条RPC前抛AdapterStateError。23项focused检查独立通过，无待修项。AdapterExecutionError的默认traceback隐藏原provider异常链，未知SDK终态转为有限unknown标签。

本次完成DSH双协议适配基础，而非四种引擎的集成。未接入Codex/Hermes，未提供通用取消或审批UI；本批没有真实故障注入或跨进程resume。旧的真实ACP跨进程恢复证据仍在[协议语义实验](../../labs/protocol-semantics/README.md)，不冒充这批共同场景。7.4容器/远程执行、复杂历史数据和其他引擎集成继续保留为后续工作。

最后补充了协议特有评分反例：SDK返回ACP式settled或缺少rootcompleted时，即使文本正确也不能通过；真实记录中的native字段已经满足加强后的检查，该修改经反例与完整109项测试验证，未追加模型调用。
