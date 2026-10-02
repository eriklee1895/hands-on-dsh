# 官方 Web 恢复与控制边界验收

日期：2026-10-02。学习仓库基线 `e2523d9`；npm `@deepseek-ai/dsh@0.1.7-rc.2`，只读核对固定 upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。实验为 macOS arm64、Node `26.7.0`、pnpm `12.3.4`，使用官方 `web` profile、独立 home/workspace、上游网页内目录选择器 overlay、当前 Flash 路由和专属 Chromium。操作方法见 [Web 恢复 Lab](../../labs/web-host-lifecycle/RECOVERY.md)，白名单数字见[元数据](../../labs/web-host-lifecycle/evidence/2026-10-02-recovery.json)，可逐项比较的摘要见[迟到审批哈希关联](../../labs/web-host-lifecycle/evidence/2026-10-02-late-correlation.json)。

## 实际观察

原实验有四个新 Session，均由官方 Web Host 持有；随后又在独立的新 Host/home/workspace 中补一个迟到审批 Session。浏览器页面、同源 `/api/session/prompt`、持久 V4 与受控 workspace 文件交叉核对；没有自建后端、自动重发模型任务或读取私人历史。原实验两次 Host 启动顺序复用相同 home/port。真实用户模型任务为审批、串行重复、crash 和补充的迟到审批各一次；断线与并发探针还产生三轮无工具回答。直接协议探针的 `requestId` 与每次传输的 `rpcId` 分开。

| 案例 | 协议/UI 观察 | Host 退出后公开 backend 与文件 |
| --- | --- | --- |
| 审批等待中取消 | 只读写入先被 sandbox 拒绝，第二次相同命令出现审批面板；目标文件未出现。浮层遮挡自动化鼠标命中后，以页面按钮 DOM click 触发“停止生成”，面板撤回、页面显示“已停止” | 34 事件；一次 `approval/asked → decided(cancelled)`，第二次 Bash error，根 `turn/end=aborted(user)`；目标文件不存在 |
| 同一事件的迟到结果 | 新实验在审批面板出现时，对官方 WebSocket waterfall 的 client/event/Agent/call ID 只保存 SHA-256。页面 stop 后，同一已认证浏览器向 `/api/$events/result` 交付原 ID 的 `allowed-once`，再交付随机 event ID 负对照；CDP 独立记录实际 POST 正文的 ID 哈希及两份回执，两次均 HTTP 200 / RPC OK | 原 POST 的 client/event 哈希匹配 live frame；frame 的 Agent/call 哈希匹配持久 Session/`approval/asked`，随机 event 哈希不匹配。34 事件仍只有一次 `decided(cancelled)` 和一个 `aborted(user)` turn，无后续 turn；`approval-stale.txt` 不存在 |
| 串行重复 | 同 `requestId` 的两个顺序 POST 均 HTTP 200 / `accepted=true` | 26 事件；匹配 prompt 只接纳一次，一次 Bash call/result、一个 completed turn；追加文件恰好三个字节 `DUP` |
| admission 断线 | 两条不同 prompt 分别在请求发起后约 0/5 ms 注入 fetch abort；两次浏览器均见 `AbortError` | 第一条无 inbox 插入、无 `user/message`；第二条一次插入、一次 `user/message`、completed；无法从本地异常直接判断接纳 |
| 同 ID 并发重复 | 同 Session 两个同时 POST 均 HTTP 200 / `accepted=true` | 相同 `requestId` 有两次 inbox 插入和两次 `user/message`，各有 completed turn；无工具或外部副作用。这反驳并发 exactly-once |
| Host SIGKILL | 一次 foreground Bash 写 STARTED 后等待 20 秒；看到开始标记时强杀本实验 Host。启动器报告 `SIGKILL`/失败退出；无 prompt 重放 | 强杀后冷读 19 事件、已有 `tool/call`、缺 result/end。新 Host 加载后 23 事件，补 `TOOL_OUTCOME_UNKNOWN`、`step/end`、`turn/end(interrupted)`；延迟文件最终有五字节 `CRASH` |

`admission` Session 共 38 事件、三个 completed turns：一轮来自第二条 abort 后仍接纳的 prompt，两轮来自并发重复。`crash-started.txt` 与 `crash-count.txt` 的 mtime 相差 20 秒。保留的白名单元数据没有精确 kill 时间戳，因此不能仅凭此断定延迟写入发生在 kill 信号前还是后；它足以证明持久日志的“结果未知”不能解释为“外部写入不存在”。重启过程也不是把原 turn 恢复为成功；修复结果明确是 interrupted。

最后一次 Host 通过主动 SIGINT/code 130 停止；两个启动器/Host 及强杀前记录的直属子进程 PID 在清理检查时均不存在。这个离散检查不是完整进程树审计。浏览器在 Host 重启后刷新，旧 Session 和已中断的一轮仍可见；没有调用新的 prompt。所有持久判断均在 Host 停止后以公开 JSONL backend 重新读取，精确文件内容另由 filesystem 检查。

## 固定源码与推论边界

[Session prompt](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/api/session-controller/src/commands.ts)先用 `requestId` 查 live inbox/已写 user message，之后跨异步 admission 并提交。串行同 ID 的已接纳输入被识别；并行竞争可在前一次提交前共同通过检查。本次实测到了并发两次接纳，不扩大为所有并发交错都会重复。浏览器 [pending submission](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/api/session-controller/src/client/sessions/session.ts)只是一份 UI 回显；恢复必须关联持久 inbox/user message 和业务外部效果。

[Approval service](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/interaction/user-approval/src/index.ts)在 abort 先结算时记 `cancelled`，迟到 answer 对已结算 Promise 无效；固定 upstream [测试](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/interaction/user-approval/tests/approval.spec.ts)明确向已 abort 的请求迟到交付 `allowed-once` 并检查没有第二条 decided。补充的真实 Host 探针用 SHA-256 关联页面原 waterfall、实际 outgoing POST、浏览器回执和持久 `approval/asked`，没有把 HTTP 200 单独当作 correlation 证据。随机 event ID 同样得到 200/OK，却被相关性验收拒绝。固定 [Gateway result handler](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/api/gateway/src/index.ts)对已完成 event 的有效结果做 no-op。这是同线迟到交付，不是面板消失后的人手点击测试，也没有重启原 turn。

[Agent resume](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/index.ts)取得写句柄后在 open tail 后追加 [synthetic closers](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/repair.ts)。已记录 call 而无结果的分类是 `TOOL_OUTCOME_UNKNOWN`；它提醒上层核对外部状态，不授予安全重试。此次 Bash 外部字节已经改变；强杀并不回滚或保证清理所有后代。

## 本地验收与未覆盖

`pnpm verify:recovery <isolated lab root>` 通过，校验原四份 V4 日志、固定 prompt/command、审批/工具/turn 关联和三个外部文件。`pnpm verify:late-approval <separate isolated root> <session id>` 在关联复核的全新运行中通过：要求 live frame 与 Session/call、第一条实际 POST 与 frame/浏览器回执逐项匹配，同时拒绝随机 event ID；再校验补充 Session 的无 grant/无后续 turn/无目标写入。导出的结果只包含布尔值和计数，不含原始 ID。Lab 的 focused keyless tests、owning suite、typecheck、lint、format、Node syntax 与 frozen install 的最终结果由任务报告列出。既有实时帧证据直接沿用[基础浏览器验收](2026-09-30-web-host.md)：两个最终回复各四个独立 `assistant-stream/text-delta` 帧先于 committed message；本次没有用 committed 事件冒充 token，也没有不必要地重复实时采集。

尚未验证面板消失后的人手点击、真正网络分区、跨多 Host 的并发幂等、任意外部 API 副作用、通用子进程回收或完整 Web 安全矩阵。0/5 ms abort 是标注过的客户端故障注入，时序依机器和负载而变；学习者须以原 `requestId` 的持久记录分类，不能为了符合本次数字盲目重试。

最终关联修复前还执行过一次仅核对HTTP状态与取消日志的独立迟到探针；它不能单独证明同一event，故没有作为最终关联通过证据。随后使用新的Host/Session重新采集上述完整哈希链和随机ID负对照；原四Session、早期迟到Session与最终关联Session是不同实验，不应把主表的精选证据当成总模型请求计数。独立review的关联P2已修正并复核，最终无剩余P1/P2。
