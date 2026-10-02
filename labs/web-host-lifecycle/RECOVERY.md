# 官方 Web：提交断线、重复投递与强杀恢复

本课接续[基础 Host 实验](README.md)和[审批/取消/离线控制](CONTROLS.md)。问题是：浏览器失去一次请求的响应、审批面板被撤回或 Host 突然消失后，怎样区分“没有被接纳”“已经接纳”“工具结果未知”和“外部字节已经改变”？只用页面消息或 HTTP `accepted` 不能回答这些问题。

固定版本为 npm `@deepseek-ai/dsh@0.1.7-rc.2`、源码 `477b4f420553e8a52c2fbccc464d7561b239c443`。以下实验使用官方 `web` profile 和网页内 picker overlay；浏览器调用的是 Host 的 `/api/session/prompt`，不是自建后端。前课记录的 `/api/remote.mux` 独立 `assistant-stream/text-delta` 帧仍是实时输出证据；本课的持久 `assistant/message` 只用于结算和恢复，不算逐 token 帧。

## 准备与隔离

从 `labs/web-host-lifecycle` 运行 `pnpm install --frozen-lockfile`。按 [README](README.md#安装与启动)用本地 Key 启动**新**实验目录，记录启动器打印的 `labRoot`、`hostPid` 和无 token 的 `baseUrl`；工作区只能是 `$LAB_ROOT/workspace`。在专属 `agent-browser` Session 打开 `$LAB_ROOT/bootstrap.url`，确认声明，添加该 workspace，保留 `DeepSeek-V41-Flash / High`。不要把 `bootstrap.url`、`host.log`、cookie、原始网络包、完整 Session 日志或私人 PID 列表拷进仓库。

下面每个探针只在明确指示的 Session 发送一次。浏览器中的 `requestId` 是命令身份；外层 `rpcId` 只是单次传输身份。发生 `AbortError` 时先查原 `requestId` 的持久接纳记录，不自动改 ID 重发。需要一个新 Session 时点击官方页面的“新建会话”，保留当前实验 workspace。记录选中的 Session ID 可用：

```sh
agent-browser --session dsh-web-recovery eval 'JSON.parse(localStorage.getItem("dsh.sessions.current")).sessionId'
```

## 1. 等待审批时停止，并核对迟到答案的边界

在新 Session 将访问模式设为“仅可查看”。用页面发送下面一条提示：

> Run exactly this bash command: printf '%s' 'LATE' >> approval-late.txt . Do not include the final period. Use only bash. First try under the current read-only policy. If denied by the sandbox, request workspace-write permission for the exact same command once, with a justification. Do not retry or call other tools. If cancellation arrives, stop.

等面板显示“拒绝/允许一次”且 `approval-late.txt` 尚不存在时，触发页面“停止生成”。若自动化点击被审批浮层遮挡，可对页面已有停止按钮执行 `agent-browser eval 'document.querySelector("button[aria-label=\"停止生成\"]")?.click()'`；这是对官方 UI 控件的点击。记录该 Session 为 `approval`。预期面板撤回，页面显示“已停止”；Host 退出后必须看到同一 approval ID 的 `asked → decided(cancelled)`、第二次 Bash 错误结果和 `turn/end.reason.kind=aborted`、`reason.kind=user`，同时文件不存在。

再用**新的** Session 验证同一事件的迟到结果。先在另一个终端启动只读取必要关联字段的 CDP 观察器：

```sh
CDP_URL="$(agent-browser --session dsh-web-recovery get cdp-url)"
node examples/observe-late-approval.mjs "$CDP_URL" "$WEB_ORIGIN" "$LAB_ROOT"
```

`WEB_ORIGIN` 是启动器给出的无 token `baseUrl`。观察器显示 ready 后刷新官方 Web 页面，再把上面的固定命令中的 `LATE`/`approval-late.txt` 改成 `STALE`/`approval-stale.txt`，发送一次。等审批面板出现，观察器会生成 `$LAB_ROOT/late-answer-eval.js`，其中含本次 WebSocket `clientId/eventId` 原值；它只留在忽略的实验目录。另一个 `$LAB_ROOT/late-wire-audit.json` 只保存这些 ID、Agent ID 和 tool call ID 的 SHA-256，不保存原始帧、请求正文、cookie 或 token。看到“captured”后**保持观察器运行**。确认文件不存在，使用页面“停止生成”，等待“已停止”和面板消失。此时执行一次：

```sh
umask 077
agent-browser --session dsh-web-recovery eval --stdin < "$LAB_ROOT/late-answer-eval.js" > "$LAB_ROOT/late-answer-receipt.json"
```

脚本先拒绝仍有审批面板或尚未显示“已停止”的页面，然后从该已认证页面向官方 `POST /api/$events/result` 发送原 `clientId/eventId` 的 `allowed-once`，再用同一 client ID 和随机 event ID 发送一次负对照。它直接重放同一 Web 协议的**迟到结果**，不是一次用户点击，也不重新运行模型。浏览器回执只含 ID 哈希、HTTP/RPC 状态；CDP 同时独立记录两份实际发出的请求正文中这些字段的哈希及返回状态。两次都得到 HTTP 200 / RPC OK，说明 200 **不能**证明 event ID 正确。收到两个回执后先 Ctrl-C 停止观察器，记录新 Session ID 为 `lateApproval`，再停止 Host。`pnpm verify:late-approval "$LAB_ROOT" "$LATE_APPROVAL_SESSION_ID"` 要求 live frame 的 Agent ID 哈希匹配 Session ID、call ID 哈希匹配持久 `approval/asked.callId`、真正发出的第一条 POST 和浏览器回执匹配原 client/event ID；随机 event ID 则必须不匹配。然后它核对本次 34 个事件仍只有一次 `decided(cancelled)`、一次 `aborted(user)` turn、无后续 turn，`approval-stale.txt` 不存在。固定 [Gateway result handler](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/api/gateway/src/index.ts)对已结束 event 的 result 做 no-op；固定[审批 service](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/interaction/user-approval/src/index.ts)和[迟到回答测试](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/interaction/user-approval/tests/approval.spec.ts)还验证 abort 在同一进程的 answer 竞争中获胜。未测试面板消失后的人手点击路径。

## 2. 同 ID 串行重投与并发重投

新建 `serialDuplicate` Session。在浏览器执行下面两条命令；第二条会直接调用官方 Host 两次，外层 `rpcId` 不同，内层 `requestId` 相同。只保留输出中的响应状态与 Session ID，不保存完整响应体。

```sh
agent-browser --session dsh-web-recovery eval 'sessionStorage.setItem("dsh.webRecovery.mode", "serial")'
agent-browser --session dsh-web-recovery eval --stdin < examples/browser-recovery-probes.js
```

等回复结束，确认 `duplicate-count.txt` 是三个字节的 `DUP`。本次两次 HTTP 200 都返回 `accepted=true`，关闭 Host 后仅有一次匹配的 `user/message`、一次 Bash call/result、一个 completed turn 和一次 append。`accepted` 表示投递请求被接纳，不等于本轮成功或外部恰好执行一次。

新建 `admission` Session，先执行第 3 节的断线探针，**然后在同一个 Session**执行并发探针：

```sh
agent-browser --session dsh-web-recovery eval 'sessionStorage.setItem("dsh.webRecovery.mode", "concurrent")'
agent-browser --session dsh-web-recovery eval --stdin < examples/browser-recovery-probes.js
```

本次两个并行 POST 都返回 HTTP 200 / `accepted=true`，持久日志里相同 `requestId` 有两次 inbox 插入、两次 `user/message` 和两轮 completed；这是当前发行版的**反例**。固定 [Host prompt 实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/api/session-controller/src/commands.ts)在异步 admission 之前查找 live inbox 与历史中的 `requestId`，但检查本身没有覆盖并行 admission 的整个区间。不要把串行重投的结果推广为并发 exactly-once。此探针只让模型回复固定文本，不执行工具，以免制造重复外部写入。

## 3. admission 期间连接中断

仍在 `admission` Session，先运行：

```sh
agent-browser --session dsh-web-recovery eval 'sessionStorage.setItem("dsh.webRecovery.mode", "admission")'
agent-browser --session dsh-web-recovery eval --stdin < examples/browser-recovery-probes.js
```

脚本对两条**不同**的无工具 prompt 分别在发起 `fetch` 后约 0 ms、5 ms 主动 abort。它是浏览器请求载体的故障注入，不等于拔网线，也不能精确指定服务端代码运行到哪一行。两次本地结果均是 `AbortError`；独立读取日志时第一条 `requestId` 没有 inbox 插入或 `user/message`，第二条有一次插入、一次 `user/message` 和 completed turn。浏览器没拿到响应并不意味着 Host 没接纳。时序依机器和负载变化；若重跑得到另一分支，应保留真实接纳数、不要修改证据让它符合本次数字。

固定 Host 的 [`@Remote('prompt')`](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/api/session-controller/src/index.ts)在进入命令前检查传输 signal；其后命令做 Agent/附件 admission，成功时把带 `requestId` 的 user message 交给 inbox，再回 `accepted`。浏览器的 [pending submission](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/api/session-controller/src/client/sessions/session.ts)是 UI 临时回显，不能代替耐久记录。断线后应按原 ID 查 inbox 与 `user/message`；只有确定未接纳并满足业务重试策略时才决定新提交。包含不可幂等副作用的请求还要核对外部系统。

## 4. Host 强杀和持久修复

另建 `crash` Session，保留“工作区内修改”，通过页面发送：

> Call bash exactly once with command: printf '%s' 'STARTED' > crash-started.txt; sleep 20; printf '%s' 'CRASH' >> crash-count.txt . Do not include the final period. Set timeoutMs to 60000 and run_in_background to false. Do not call other tools or retry. If the command succeeds, reply exactly CRASH_DONE.

记录 Session ID。看到 `crash-started.txt` 后、20 秒延迟写入前，仅对本实验启动器刚打印的 `hostPid` 执行 `kill -KILL "$HOST_PID"`。等待启动器报告 `signal=SIGKILL`、非成功退出；核对曾记录的直属子进程状态。**不要重发 prompt。**强杀后的冷读在本次得到 19 条事件：已有 `tool/call`，没有 `tool/result` 或 `turn/end`。

复用同一个 `$LAB_ROOT`、home、端口启动官方 Web Host，原浏览器刷新后仍选中旧 Session。Host 恢复在该日志后追加 `TOOL_OUTCOME_UNKNOWN` 的错误工具结果、`step/end` 和 `turn/end(interrupted)`；本次最终是 23 条事件。`crash-count.txt` 最终含一次五字节 `CRASH`，与开始文件 mtime 相差 20 秒。保存的元数据没有精确 kill 时间戳，因此只断言强杀前无持久结果、重开后工具结果标记 unknown、外部延迟写入确实发生；不把这条 interrupted turn 叫作 resumed success，也不推断写入相对 kill 信号的严格先后。停止第二个 Host，确认已记录的两个 Host、启动器和直属子进程 PID 都退出。

固定[恢复实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/src/index.ts)在获取写句柄后为 open tail 写合成 closer；[closer 规则](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/repair.ts)区分 `TOOL_NOT_STARTED` 与 `TOOL_OUTCOME_UNKNOWN`。它修复会话结构并给模型可见的未知结果，不会为外部副作用提供事务回滚或自动恰好一次。

## 关闭后独立验收

将这四个 Session ID 与 admission/concurrent 探针输出的三个 `requestId` 写入实验目录中的 `recovery-ids.json`，权限设为 `0600`：

```json
{
  "approval": "session-替换",
  "serialDuplicate": "session-替换",
  "admission": "session-替换",
  "crash": "session-替换",
  "abortedBeforeAdmission": "替换为 beforeAbort",
  "abortedAfterAdmission": "替换为 afterAbort",
  "concurrentDuplicate": "替换为 concurrent 的 requestId"
}
```

必须先停止 Host，随后从本 Lab 目录运行 `pnpm verify:recovery "$LAB_ROOT"` 和 `pnpm verify:late-approval "$LAB_ROOT" "$LATE_APPROVAL_SESSION_ID"`。两个验收器用公开 JSONL backend 重开 V4，核对固定 prompt/command、ID 接纳数、审批与 turn 终态，并独立读取文件；输出只含白名单计数与分类。迟到审批验收还在实验目录写 `late-correlation-proof.json`，只含可比较的 SHA-256 和结果类别。本次结果见[安全元数据](evidence/2026-10-02-recovery.json)、[哈希关联证据](evidence/2026-10-02-late-correlation.json)与[验收记录](../../docs/reviews/2026-10-02-web-recovery.md)。继续运行 `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`。若故障注入落在别的时序分支，严格验收会失败；检查原始本地日志并如实记下实际分支，绝不自动重试来凑本次结果。

最后关闭专属浏览器，确认实验 PID 退出，再删除自己创建的 `$LAB_ROOT`。本课没有测试多浏览器并发、真正网络分区、持久跨进程幂等锁、面板消失后的人手点击、任意外部 API 副作用或完整后代进程树回收。固定源码测试覆盖同进程的迟到 answer 竞争；真实 Host 测到的是已结束 event 收到同线迟到结果后仍保持取消审计与无目标写入。以上结论只对应固定发行版和本次受控文件实验。
