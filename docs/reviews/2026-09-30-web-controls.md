# 官方 Web 的审批、取消和离线验收

日期：2026-09-30。基线 `fc67f56`，继续 [Web Host Lab](../../labs/web-host-lifecycle/CONTROLS.md)。DSH npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`，macOS arm64、Node `26.7.0`、pnpm `12.3.4`、agent-browser `0.37.0` / Chromium。

## 真实浏览器与持久结果

使用公开 web profile、独立 home/workspace、网页内 picker；一个 Host、三个 Session、四个用户 turn。模型任务没有自动重放。所有命令只针对实验自己的文件。

| 案例 | UI / 外部观察 | 关闭后的持久验收 |
| --- | --- | --- |
| 拒绝 | readonly 写入拒绝后出现审批；待审批时无目标文件；点拒绝后 `DENIED`，文件仍不存在 | 两次相同 command 的 Bash，第二次请求 workspace-write；关联 asked/decided=`rejected`；第二个 result error，根 turn completed |
| 允许一次 | 同一会话仍 readonly；待批准时无文件；点允许一次后 `ALLOWED`，36 字节准确；页面仍仅可查看 | 两次 Bash，关联 outcome=`allowed-once`；第二个 result 成功，根 turn completed；最终持久 mode 仍 read-only |
| 取消 | 先写 STARTED，sleep45 期间点停止；页面已停止，两个观察到的子进程退出；超过45秒仍无后续文件 | 一次 foreground Bash，失败 result，`aborted.reason.kind=user`；开始标记保留 |
| 离线 | STARTED 后关闭浏览器网络并 reload，出现 ERR_INTERNET_DISCONNECTED；Host 在离线时完成 append；恢复后同 Session、RECONNECTED 一条最终回复、1轮2步 | 一次 prompt、一次成功 foreground Bash、一个 completed turn；追加文件只含一次36字节值 |

Session ID 与事件数：

- 审批：`session-fe2ab813-366c-4ea3-8f85-9b52be57fc6e`，61 条。
- 取消：`session-149818a1-cea4-49a4-8fd3-61573584ee87`，22 条。
- 离线：`session-4eddfda3-a76f-4fa1-bd51-3a441b49a497`，26 条。

允许和离线产物 SHA-256 均为 `3f3f8f6f0f5eef5436d4c19047e7487ad47ab14e708d128ceab1633cc4eef57a`。拒绝文件和取消延迟文件均不存在。两个慢命令显式使用 `timeoutMs: 60000`、`run_in_background: false`；不把 jobs registry 中的记录误认为 detached job。

Host PID `6762` 经启动器 SIGINT 停止，CLI code130。取消前观察到的子进程 `22269 / 22270` 在取消后均不存在；停止 Host 前的离散快照 `6707 / 6761 / 6762` 在停止后均不存在。它们不是完整进程审计，code130 也不能单独证明 disposal 或 flush 成功，因此三个 Session 都在 Host 退出后通过独立公开 JSONL backend 重读。

## 离线证据的范围

浏览器 offline 模拟只作用于浏览器，Host 到模型服务的网络仍可用。开始标记先出现，追加文件在 offline 前尚不存在；离线错误页显示期间，文件完成一次追加，marker 与产物 mtime 间隔约12秒。回到 online 后，原 Session ID 不变。metadata collector 记录了 remote.mux 的连接尝试与新的 baseline/snapshot，但连接创建数量不等于成功重连次数。

首次采集脚本误以为 reload 会返回非零 code；agent-browser 实际返回了 chrome-error 页面，故改为核对页面中的 ERR_INTERNET_DISCONNECTED。没有因此重发模型任务。`navigator.onLine` 在该 Chrome 错误页读到 true，未把它当成有效联网证据。

关闭浏览器后读取 CDP 观察器结果为 exit1 / `CDP observer failed`；采集文件已经保存。本次不声称观察器无错误退出，离线结论还由错误页、外部文件及持久记录交叉核对。教程明确要求先停止观察器再关闭浏览器。该问题未修改成成功码，也未触发任务重放。

## 验证与复核

| 检查 | 结果 |
| --- | --- |
| Lab keyless tests | 8 项通过：原4项与新增4项控制验证器测试 |
| typecheck / lint / format / frozen install | 通过 |
| 真实模型 | 四个用户 turn、六次 Bash；三组 Session 的公开 backend / 文件验收通过 |
| 独立代码 review | 无 P1/P2；reviewer 独立运行8项测试通过 |
| 暂存 diff / credentials | diff 检查通过；18 个文件凭据模式与个人绝对路径命中均为0；截图已目视复核 |
| 文档、链接、图表 | 最终独立复核无 P1/P2；9 篇变动 Markdown、107 个相对链接、3 个图表通过 |

证据验证器先以占位实现失败，再补关联和终态判断；源码进一步确认实际审批应含“只读尝试 + 一次请求更宽权限”，对应 fixture 调整后重新经历 RED/GREEN。持久内容没有用页面文案或模型回复替代。两张提交截图只含离线页和最终对话，没有认证材料或模型推理正文。

## 尚未验证

未覆盖审批等待时取消/迟到回答、重复点击/RPC、prompt admission 期间断线、Host 崩溃、排队 inbox、真正后台 job、多层子任务树、其他平台和任意外部副作用。已发生写入不会因取消自动回滚；根 completed 不等于每个工具操作成功；一次 append 观察不构成通用 exactly-once 保证。安全元数据见 [controls JSON](../../labs/web-host-lifecycle/evidence/2026-09-30-controls.json)。
