# 第 7.7–7.8 课：显式能力与跨引擎适配

假设业务服务想把同一句任务交给四个入口：DSH SDK JSON-RPC、DSH ACP、Codex CLI 和 Hermes CLI。把方法都叫 `prompt()` 很容易，但“可以再发一条吗”“close 会等任务完成吗”未必有同一个答案。

本课先比较 DSH 的两个入口，再加入两个独立 CLI adapter。共同接口提供 `prompt(text)`、`close()` 和显式能力描述；终态、复用与关闭规则仍需逐项保留。两款 CLI 的 nonce 和文件真实任务均已通过，具体版本与早期失败证据见[验收记录](../../docs/reviews/2026-10-02-cross-engine.md)。

前置：[协议语义实验](README.md)、[业务 Eval](../../projects/recoverable-agent-service/EVAL.md)。DSH 继续使用本 lab 的 npm `0.1.7-rc.2`、ACP protocol v1 和既有 JSONL peer。Codex/Hermes 使用各自 CLI JSONL 事件流，并非 SDK JSON-RPC；专用 reader 不发送伪造的 JSON-RPC 请求。

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

## 2. 先理解 DSH 两个入口的结果

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

## 3. 同名方法还需要生命周期说明

| 能力 | SDK adapter | ACP adapter |
| --- | --- | --- |
| prompt / process close | supported | supported |
| session close / 同一 owner 内 resume | unsupported | supported |
| cancel | unsupported | probe-only |
| permission 交互 | unsupported | probe-only |
| token stream | unsupported | unsupported |

先看成功之后是否还能复用，以及活动期调用 close 的后果。下面的“实例”是 lab 的 adapter 对象，不能用它代替持久业务 Run：

| 入口 | 每实例 prompt 与复用 | 活动期 close | native cancel |
| --- | --- | --- | --- |
| DSH SDK | 成功后可继续顺序提交 | 关闭接纳，等自有操作结算，再回收进程 | unsupported |
| DSH ACP | Session 开启时可继续顺序提交 | 同样等待自有操作，再协议关闭与回收 | 只有 fake probe |
| Codex CLI | one-shot，只接纳一次；下次新建实例 | 终止并回收仍存在的进程组，不等待业务完成 | not-integrated |
| Hermes CLI | one-shot，只接纳一次；下次新建实例 | 同样终止并回收进程组 | not-integrated |

DSH 的等待结算是 drain；CLI 的关闭是 terminate-and-reap。它们都负责清理资源，但活动期调用会产生不同后果。CLI 即使正常完成，实例也进入 `finished`，不会重新开放 prompt；[`comparison.py`](src/protocol_labs/comparison.py) 因此为每个 CLI 场景创建一个新 adapter。所有入口的 process close 都不能当作 native cancel 成功的证明。

`supported` 表示本适配层提供实现；`unsupported` 限定这里锁定的协议/入口；`probe-only` 表示当前只有明确范围的实验，不是通用生产接口。`describe_adapter()` 对 Codex `exec-jsonl` 和 Hermes `chat-stream-json` 报告已实现的 prompt/process close；session close、resume、native cancel、逐 token 文本消费和 permission 仍是 `not-integrated`。这个标记只描述本 lab 的实现，不判断产品是否提供相应功能。

`cancel_probe()` 仅适用于 ACP fake，复用既有 readiness-then-cancel 实验。它不能取消任意已发出的 prompt，也不接受 package 模式。ACP 的协议本身有 cancel 通知，但要实现通用 UI 取消还需定义发送时机、完成与取消的竞态、请求状态和部分输出；本课没有把这些未实现语义藏在一个布尔值里。

permission 也仅保留受控实验的证据，本 Adapter 默认拒绝一次性请求，不能当成生产审批客户端。生产 prompt 示例要求不调用工具，并核对实际工具事件为零。

调用 SDK 的 session close、resume 或 cancel 扩展会在发出 RPC 前抛 `UnsupportedCapability`；不会用“关闭整个进程”冒充 session close，也不会用新建 Session 冒充 resume。

## 4. DSH Adapter 失败后为什么不能继续复用

本节描述 [`adapters.py`](src/protocol_labs/adapters.py) 中的 DSH 双入口；CLI 的 one-shot 关闭规则见上表和第 6 节。一个 DSH Adapter 同时只接纳一个 prompt，忙时拒绝新的输入。超时、EOF 或 RPC 失败产生 `AdapterExecutionError`，只保留有限 kind，并保守标为 `may_have_executed=true`。没有证据证明任务未产生副作用时，不自动重放。

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

## 6. 运行 Codex 与 Hermes 的独立场景

这里每个场景都新建 adapter、临时状态目录与 CLI 进程。安装两款 CLI 并完成它们自己的账户配置后，从本 lab 目录运行：

```sh
uv run --python 3.10 python -m protocol_labs.comparison --engine codex --server binary
uv run --python 3.10 python -m protocol_labs.comparison --engine hermes --server binary
```

先看任务：第一个要求精确回复随机 nonce，第二个要求在独立临时 workspace 写入 `result.txt`，再由脚本核对实际文件字节。nonce 只允许完全相同的文本或末尾恰好一个换行；前置空白、额外空行和后置空格均失败。脚本只输出 hash、状态和布尔验收，不输出提示词、回答或凭据；有不确定结果时不自动重发。

再看账户与环境。Codex 使用当前配置的 model、内建 OpenAI provider，将 `auth.json` 精确复制到 `0700` 临时 home，文件为 `0600`；`--ignore-user-config`/`--ignore-rules` 避免加载个人 MCP 与规则，执行时选择 `workspace-write`。Hermes 从当前配置读取 model/provider，仅支持这里验证的 `deepseek` provider；只把对应 key 写入临时 `0600` `.env`，用 `--safe-mode` 禁用个人插件、MCP 和规则。独立目录和这些配置选择不构成跨引擎统一的安全 sandbox，不能据此推断任意工具都只能访问 workspace。

私有文件在写入首个字节前即以 `0600` 创建，准备失败时删除临时状态。可执行文件默认从 PATH 查找，也可用 `CODEX_ADAPTER_BIN` / `HERMES_ADAPTER_BIN` 指定。特定账户通过 `CODEX_ADAPTER_CONFIG`、`CODEX_ADAPTER_AUTH`、`HERMES_ADAPTER_CONFIG`、`HERMES_ADAPTER_ENV` 指向确切文件；model 可通过 `CODEX_ADAPTER_MODEL`，或 `HERMES_ADAPTER_MODEL` 加 `HERMES_ADAPTER_PROVIDER` 指定。无需改变原有登录。

最后看结果是否真正结算：

| CLI | 事件要求 | 进程退出与状态 |
| --- | --- | --- |
| Codex `exec --json` | `thread.started`，唯一末尾 `turn.completed` | 退出 0 才 completed；`turn.failed` 或非零为 failed |
| Hermes `chat --format stream-json` | `system/init`，唯一末尾 `result` | `exit_code` 与进程返回码一致；0 为 completed，130 为 interrupted，其余非零为 failed |

Hermes 0.21.5 在 `system/init` 后可能向 stdout 打印一条固定的 `tirith` 缺失警告。adapter 只允许这条源码可定位的警告出现一次，并在 `native.startupWarning` 标记；其他非 JSON 行、提前 EOF、缺少终态、超时或输出超限都报执行错误。部分文本不能代替终态。

CLI `close()` 会对仍存在的自有进程组发送 SIGTERM，必要时升级 SIGKILL；它不先等待 prompt 正常结算。只有独立确认回收后才删除临时状态。这是资源清理，不是 native cancel，也不撤销已经产生的外部副作用。真实二进制与真实模型任务是两级证据：`--version`/`--help` 只确认入口存在，不说明模型任务可用。

Codex 0.156.1 与 Hermes v0.21.5 各在本机完成两个新的真实任务：nonce 精确匹配且零工具事件；文件字节精确匹配并观察到工具事件。Hermes 的成功结果保留 `startupWarning=tirith-unavailable`，并非声称 CLI stdout 完全干净。早期失败的两条任务没有重放；成功证据来自独立的新 nonce 和 workspace。更完整的语义矩阵见[跨引擎对比](../../docs/comparisons/dsh-codex-hermes.md)。

## 7. 检查与后续扩展

练习：假设调用方要连续提交两条任务，分别为 DSH SDK 和 Codex CLI 写出对象创建、prompt、close 的顺序，只画调用顺序即可。再设想第一条还在执行时服务开始关闭，对照生命周期表，说明哪个会等待、哪个会终止进程，以及为何两者都不能自动重放原任务。

```sh
uv run --python 3.10 pytest tests
uv run --python 3.10 ruff check .
uv run --python 3.10 ruff format --check .
uv lock --check
```

CLI 退出码 0 表示本次选择的所有检查通过，1 表示检查失败，2 表示配置或执行基础设施错误。DSH fake/package 和 CLI binary 三种证据分别报告；DSH 原始验收见[第 7.7 课记录](../../docs/reviews/2026-09-30-runtime-adapters.md)，跨引擎记录见[第 7.8 课记录](../../docs/reviews/2026-10-02-cross-engine.md)。

7.7 保留 DSH 双协议适配基础；7.8 新增两个 CLI 入口并完成该版本的 nonce/文件真实验收。所有引擎的通用取消、审批与其他平台验证仍待完成。业务 Run 的持久状态、授权、幂等和产物检查仍由应用负责。
