# Web 控制：拒绝、单次允许、取消与离线

本课接续[官方 Web Host 基础实验](README.md)，沿用同一 `0.1.7-rc.2` 与工具链。三个问题分别验证：用户是否允许本次操作、已开始的操作是否停止、浏览器是否仍连接。它们不能互相替代。

## 准备

按 README 完成安装、启动一个**新的**实验目录、登录和添加 `$LAB_ROOT/workspace`；这次不发送基础实验的两条提示。在 Lab 目录准备固定命令：

```sh
pnpm exec node --import tsx examples/prepare-controls.ts "$LAB_ROOT"
```

`control-cases.json` 保存本次随机值、四条命令和各自的 prompt。`prepare-controls.ts` 不执行命令、不调用模型，也不覆盖已有案例文件。将对应 `cases.<name>.prompt` 原样复制到页面发送。记录 Session ID 的方法仍是该固定版本页面的本地选中状态：

```sh
agent-browser --session dsh-web-lesson eval 'JSON.parse(localStorage.getItem("dsh.sessions.current")).sessionId'
```

每条 prompt 只发送一次；失败不自动重发。模型如果改变命令、调用其他工具或重试次数不符，验收应失败。

## 1. 拒绝和允许一次

在第一个 Session 中将访问模式改为“仅可查看”。先发送 `cases.denied.prompt`，目标是 `denied.txt`。

官方 Bash 的正常路径是：先在 read-only 下尝试，得到明确的 sandbox denial，再用**完全相同的 command** 请求 `workspace-write`，携带 `sandbox_permissions` 与 `justification`。因此这里预期两次工具调用，不是一次。第一个 shell 失败可能仍返回正常的工具消息，必须读其中的 `[sandbox: file access denied under read-only mode]`；不能只根据 `isError` 判断是否写入成功。

等审批面板出现，确认 `denied.txt` 尚不存在，再点击“拒绝”。预期最终回复 `DENIED`，文件仍不存在。持久审计有同一个 ID 的 `approval/asked → approval/decided(rejected)`，关联第二个 tool call；其 result 为 error。**根 turn 仍可 completed**，表示模型结束了本轮，不表示被拒绝的操作成功。

在同一个 Session 发送 `cases.allowed.prompt`。等审批面板出现，先确认 `allowed.txt` 不存在，再点击“允许一次”。预期 `ALLOWED`，文件精确等于本次随机值；审计为 `allowed-once`，关联工具结果成功。页面仍显示“仅可查看”，最后一条持久 `sandbox/mode` 仍为 read-only，未把会话改为长期可写。记录这个 Session ID 为 `approval`。

## 2. 取消正在运行的 Bash

新建第二个 Session，确认它使用“工作区内修改”，发送 `cases.cancel.prompt`。命令先写 `cancel-started.txt`，等待 45 秒，再准备写 `cancel-finished.txt`。

```sh
test -f "$LAB_ROOT/workspace/cancel-started.txt"
```

开始标记出现后立即点击“停止生成”，必须早于延迟写入。等待页面显示“已停止”，记录 Session ID 为 `cancel`。验证器要求一次匹配的失败工具结果，以及 `turn/end.reason = { kind: 'aborted', reason: { kind: 'user' } }`。点击返回或停止按钮消失都不能替代这个终态。

本次观察到正在运行的两个子进程退出，开始标记保留；超过原定 45 秒后，结束文件仍不存在。**取消不是回滚**：已完成的第一份写入仍在。也不能从本例推出外部系统写入、主动脱离进程组的进程或已分离 job 一定可取消。

提示明确指定 `timeoutMs: 60000`、`run_in_background: false`。这避免较短 foreground timeout 把命令转为 detached job。官方 Web 会把命令登记到 jobs，UI 显示 job 不等于本例采用了后台分离执行。

## 3. 浏览器离线，Host 继续工作

新建第三个 Session，确认“工作区内修改”，发送 `cases.reconnect.prompt`。命令先写 `reconnect-started.txt`，等待 12 秒，再向 `reconnect-count.txt` **追加**本次随机值。记录 Session ID 为 `reconnect`。

开始标记出现且追加文件尚不存在时，在浏览器自动化上下文中离线并刷新：

```sh
test -f "$LAB_ROOT/workspace/reconnect-started.txt"
test ! -f "$LAB_ROOT/workspace/reconnect-count.txt"
agent-browser --session dsh-web-lesson set offline on
agent-browser --session dsh-web-lesson reload
```

必须检查页面确实显示 `ERR_INTERNET_DISCONNECTED`。本机 agent-browser 的 reload 返回了 `chrome-error://chromewebdata/`，退出码仍为 0；命令退出码不能替代错误页观察。这里切断的是浏览器上下文的网络，Host 与模型服务之间的网络保持可用。

![浏览器处于离线错误页](assets/browser-offline.png)

保持浏览器离线，观察追加文件出现。此次 Host 完成了写入；浏览器离线没有发送取消，也没有让 Host 自动暂停。然后恢复连接：

```sh
agent-browser --session dsh-web-lesson set offline off
agent-browser --session dsh-web-lesson open "$WEB_ORIGIN"
```

`WEB_ORIGIN` 使用启动器打印的无 token `baseUrl`。等待原 Session 历史加载，确认 ID 相同、只有一条独立最终回复 `RECONNECTED`，并显示“1 轮 2 步”。不要再次发送 prompt。最终文件必须只含一次随机值；用 append 而不是覆盖写，才能发现这次写入被执行两遍。

![重连后原会话展示已完成的任务](assets/browser-reconnected.png)

## 关闭后验收

将记录的三个 ID 写到实验目录：

```sh
cat > "$LAB_ROOT/control-session-ids.json" <<'JSON'
{
  "approval": "替换为审批 Session ID",
  "cancel": "替换为取消 Session ID",
  "reconnect": "替换为离线 Session ID"
}
JSON
```

等待取消开始标记的修改时间已过去至少 45 秒。在启动器终端 Ctrl-C，等待 Host 退出并核对 PID；再执行：

```sh
pnpm verify:controls "$LAB_ROOT"
pnpm test
```

[`verify-controls.ts`](examples/verify-controls.ts) 重读公开 JSONL backend，核对三个 Session 的 ID、cwd、V4 header、每个 prompt 一次、工具/审批关联和终态，并独立读取文件。它不替代中间的 UI、离线错误页和进程观察。metadata collector 若启用，先 Ctrl-C 停止观察器，再关闭专属浏览器；最后按 README 删除自己创建的实验目录。

2026-09-30 验收：审批 Session 61 条事件，拒绝/允许各两次 Bash；取消 Session 22 条事件，user-caused aborted；离线 Session 26 条事件，completed。允许文件与追加文件各 36 字节且内容相同；拒绝文件和取消的延迟文件均不存在。Lab 共 8 项无 Key 测试通过。详见[验收记录](../../docs/reviews/2026-09-30-web-controls.md)与[安全元数据](evidence/2026-09-30-controls.json)。

## 从源码解释观察

```mermaid
flowchart TD
    Start[工具请求] --> Policy{当前写入策略}
    Policy -->|只读拒绝| Ask[同一命令请求更宽权限]
    Ask --> Decision{本次用户决定}
    Decision -->|rejected| NoWrite[不执行重试写入]
    Decision -->|allowed-once| Write[仅本次执行]
    Active[Host 中运行的 foreground 命令] --> Cancel[用户请求 session cancel]
    Cancel --> Aborted[等待工具停止与 aborted 终态]
    Active --> Offline[浏览器离线并刷新]
    Offline --> Continue[Host 继续推进]
    Continue --> Reload[重连后读取历史与当前状态]
```

固定源码的 [Session cancel](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/api/session-controller/src/commands.ts) 调用 `agent.cancel({ kind: 'user' }, { keepInbox: true })`，只返回 accepted；本例没有排队消息，不能据此宣称队列已清空。[审批 service](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/interaction/user-approval/src/index.ts) 记录问答 ID；[Bash consumer](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/shell/tool-bash/src/index.ts) 在更宽策略执行之前等待批准。

未覆盖：审批等待时取消及迟到答案、重复点击/重复 RPC、断线中的 prompt admission、正在执行时 Host 崩溃、任意任务树回收、真正后台 job、所有平台与网络故障。本次“一次追加”是受控观察，不是通用 exactly-once delivery 保证。
