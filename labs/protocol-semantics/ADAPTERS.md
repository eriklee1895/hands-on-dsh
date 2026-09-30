# 第 7.7 课：适配层基础——DSH 双协议与显式能力

本课把同一项任务交给 DSH 的 SDK JSON-RPC 和 ACP 两种入口，验证应用可以统一哪些结果，以及哪些控制必须保留差异。两者的 engine 都是 DSH；本课没有接入 Codex 或 Hermes，不能将它们未接入本仓库写成产品不支持某项能力。

前置：[协议语义实验](README.md)、[业务 Eval](../../projects/recoverable-agent-service/EVAL.md)。继续使用本 lab 的 npm DSH `0.1.7-rc.2`、ACP protocol v1 和既有 JSONL peer，不增加依赖或另写一份 transport。

## 1. 先运行共同场景

从仓库根目录开始：

```sh
cd labs/protocol-semantics
uv sync --locked --group dev
pnpm install --frozen-lockfile
uv run --python 3.10 python -m protocol_labs.comparison
```

默认是受控 fake peers，不访问模型。共有 13 个检查场景：两个协议各有正常 prompt、timeout、peer EOF、JSON-RPC error；SDK 明确拒绝三个不支持的扩展；ACP 验证同进程 session close/resume 和确定性的 cancel fixture。

预期 selected=13、passed=13、failed=0。超时、EOF 和 RPC 错误用例“通过”，指客户端正确报告失败并拒绝继续复用，不是工作完成。每个场景还要求进程组回收与临时状态目录删除得到确认。

```sh
uv run --python 3.10 python -m protocol_labs.comparison --negative-control
```

负对照会故意将第一条精确文本检查改为 false，退出码为 1；其余场景照常执行。它不修改 adapter 或生成一份新的期望答案。

## 2. 共同接口只描述已有事实

[`adapters.py`](src/protocol_labs/adapters.py)复用 SdkProbe、AcpProbe、OwnedState 和公开 launch resolver。两个 Adapter 共享 `prompt(text)` 与 `close()`，结果保留：

| 字段 | 意义 |
| --- | --- |
| engine / protocol | DSH 引擎与 sdk-jsonrpc 或 acp 入口 |
| status | completed、settled、cancelled 或 incomplete |
| text | 已提交文本，可能为空；不能单凭非空文本判断成功 |
| session_id | 当前 owner 内的底层 Session 引用，不是业务 Run ID |
| settlement | 原协议使用的结算规则 |
| native | 有限的协议结果字段，便于解释统一状态 |
| tool_events | 本课观察到的根工具事件数量 |

SDK 实验的 Session 名为 `root`，不同 owner 的这个名称不具有全局唯一性；跨 owner 聚合时仍需应用提供存储 sourceId 等定位信息。

SDK 的 completed 必须建立在 matching inbox receipt、根 turn completed 和之后的根 idle 上。ACP 根据 prompt 返回的 stopReason 与 committed updates 结算：end_turn 只映射为 settled，因为固定版本还会把 aborted/blocked 映射为 end_turn；max_tokens 映射为 incomplete。只有 ACP 真正返回 cancelled 才报告 cancelled；本地 waiter 取消、连接断开或杀进程都不能直接翻译成它。native cancelled 也可能来自中断或 disposal，不能只凭这个字段推断发起取消的主体。

`tool_events` 只用于本课验证零工具：SDK 数根 `tool/call`，ACP 数 `tool_call` 和 `tool_call_update`。非零时这些数字不是同一种“工具次数”，不能直接跨协议相加或比较。两者也都没有在本课提供逐 token transport。

## 3. 能力表优先于统一方法名

| 能力 | SDK adapter | ACP adapter |
| --- | --- | --- |
| prompt / process close | supported | supported |
| session close / 同一 owner 内 resume | unsupported | supported |
| cancel | unsupported | probe-only |
| permission 交互 | unsupported | probe-only |
| token stream | unsupported | unsupported |

`supported` 表示本适配层提供实现；`unsupported` 限定这里锁定的协议/入口；`probe-only` 表示当前只有明确范围的实验，不是通用生产接口。`describe_adapter()` 对 Codex/Hermes 返回 `not-integrated`，不进行任何启动或产品能力推断。

`cancel_probe()` 仅适用于 ACP fake，复用既有 readiness-then-cancel 实验。它不能取消任意已发出的 prompt，也不接受 package 模式。ACP 的协议本身有 cancel 通知，但要实现通用 UI 取消还需定义发送时机、完成与取消的竞态、请求状态和部分输出；本课没有把这些未实现语义藏在一个布尔值里。

permission 也仅保留受控实验的证据，本 Adapter 默认拒绝一次性请求，不能当成生产审批客户端。生产 prompt 示例要求不调用工具，并核对实际工具事件为零。

调用 SDK 的 session close、resume 或 cancel 扩展会在发出 RPC 前抛 `UnsupportedCapability`；不会用“关闭整个进程”冒充 session close，也不会用新建 Session 冒充 resume。

## 4. 失败与资源状态分开处理

一个 Adapter 同时只接纳一个 prompt，忙时拒绝新的输入。超时、EOF 或 RPC 失败产生 `AdapterExecutionError`，只保留有限 kind，并保守标为 `may_have_executed=true`。没有证据证明任务未产生副作用时，不自动重放。

失败后 Adapter 进入 faulted，必须 close，不能把下一条输入直接发到状态不明的 owner。调用方任务取消时原样传播 CancelledError，也会阻止继续复用；这与 ACP 的 native cancelled 不同。

close 先关闭接纳，等待自己拥有的操作结算，再执行协议关闭与有界进程组回收。多个 close 调用方共享同一次清理；某个等待方取消不应中止它。实现跟踪的是 prompt 操作本身，不等待包含调用方 finally 的整段任务，避免互相等待。

关闭摘要区分 group_gone、returncode、信号升级和 native_clean_exit。故障场景可能需要升级信号才能回收，不能把 group_gone 等同于任务成功。只有 owner close 与独立进程组检查都确认后才删除自己创建的目录；未确认时保留状态，报错不输出原始 provider 消息或凭据。

## 5. 用同一条真实任务比较两个入口

环境已有 DEEPSEEK_API_KEY 时：

```sh
uv run --python 3.10 python -m protocol_labs.comparison --server package
```

也可以从被忽略的根目录 `.env` 加载：

```sh
uv run --env-file ../../.env python -m protocol_labs.comparison --server package
```

脚本通过本项目安装并核对版本的公开 `dsh` CLI，分别启动 sdk-minimal 与 acp，给两个入口发送同一个随机 nonce 回复任务。两者都必须精确回复、按各自协议正常结算、零工具事件、正常关闭并确认进程组消失。SDK 还观察到 root completed；ACP 不提供等价的根终态证明。输出只给文本 hash 和精确匹配结果，不打印 prompt、reply 或 API key。

这批真实模式只有两个 prompt 场景，故障、cancel、resume 等明确列为 not_run。之前的 ACP 跨进程 resume 证据在[协议实验](README.md)中；本次 fake 的同进程 close/resume 不能取代它，也不扩大为通用历史会话可恢复。

```sh
uv run python -m protocol_labs.comparison --engine codex
uv run python -m protocol_labs.comparison --engine hermes
```

这两条返回 not-integrated 并退出 2，不调用对应产品、不安装任何 runtime。新增其他引擎时，应从它的官方入口、真实能力和结果语义重新验收，不能只把名字添加到表格就算接入。

## 6. 检查与后续扩展

```sh
uv run --python 3.10 pytest tests
uv run --python 3.10 ruff check .
uv run --python 3.10 ruff format --check .
uv lock --check
```

CLI 退出码 0 表示本次选择的所有检查通过，1 表示检查失败，2 表示配置、未接入或执行基础设施错误。fake/package 两种证据分别报告，详见[本课验收](../../docs/reviews/2026-09-30-runtime-adapters.md)。

7.7 本次完成 DSH 双协议的适配基础。真正的跨引擎 Codex/Hermes 适配、通用取消与审批、其他平台验证仍待实现；这与 7.4 的容器/远程执行缺口一起保留在[工程化路线](../../docs/learning-paths/engineering.md)。业务 Run 的持久状态、授权、幂等和产物检查仍由应用负责，不因有了统一 prompt 接口而消失。
