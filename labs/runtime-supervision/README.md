# 第一课：一个 runtime 的所有权、超时与重建

这次实验回答：当一个 DSH 调用超时或进程连接丢失时，应用何时可以接收下一条输入？读完并运行后，你应能解释为什么“重新启动进程”不等于“安全重做任务”，并观察到关闭失败时 slot 被隔离。

前置知识：[TypeScript SDK 教程](../../tutorials/typescript-sdk/README.md)中的 run/session 与 receipt-to-idle，以及[新版变化审查](../../docs/reviews/2026-09-28-upstream-refresh.md)。本实验使用新版公开 API，不需要准备 upstream source checkout。

## 版本与实验条件

- npm SDK/runtime：精确锁定 `0.1.7-rc.2`；tag `dsh-v0.1.7-rc.2`，commit `477b4f420553e8a52c2fbccc464d7561b239c443`。
- Node 支持范围 `^22.19.0 || >=24.0.0`；本次运行的 Node 为 `26.7.0`，pnpm `12.3.4`，macOS arm64。
- TypeScript strict ESM/NodeNext；`skipLibCheck` 限制检查范围为本项目源码，不对发布包的全部传递声明做审计。
- 锁定依赖见 `package.json` 与 `pnpm-lock.yaml`。`pnpm-workspace.yaml` 明确列出 runtime/native 依赖的 build-script 决策；Google GenAI 的 no-op preinstall 不运行。

`sdk-minimal` 的默认执行策略为 `danger-full-access`，临时 workspace 和 `dshHome` 只隔离本课文件的位置。本课默认 prompt 明确不调用工具；不要把陌生指令作为参数传入。

## 1. 安装并运行故障实验

以下命令从仓库根目录开始：

```sh
cd labs/runtime-supervision
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

后面的命令都在这个目录执行。测试不读取 API key，不启动 DSH，不访问模型；可控 promise 模拟 run/close 的完成顺序，fake timers 推进活动 deadline，不依赖实际机器耗时。

按问题单独运行：

```sh
pnpm test -t 'starts lazily'
pnpm test -t 'waits for exit confirmation'
pnpm test -t 'quarantines'
pnpm test -t 'newer generation'
pnpm test -t 'shares cleanup'
```

预期结果依次是：顺序调用只创建一个 owner；超时后停在 `stopping` 等待回收；close 抛错后拒绝新输入；旧 run 的迟到结果不影响新 generation；主动 close 与失败回收只执行一次 SDK close。

## 2. 先验证真实 profile，再调用模型

```sh
pnpm smoke
```

[`examples/handshake.ts`](examples/handshake.ts)使用公开 `DeepSeekHarness`，创建独立绝对路径的 `dshHome` 和 workspace，启动 `sdk-minimal`，执行 initialize 后关闭。子进程使用一个无效占位 key，没有提交 prompt；成功只证明发布包、profile、握手和关闭可用，不能证明模型可用。首次启动可能初始化 profile 和解析依赖，因此 initialize 留出 120 秒。

预期输出包含：

```json
{"profile":"sdk-minimal","sdk":"0.1.7-rc.2","initialized":true,"modelRequests":0}
{"closed":true,"temporaryHomeRemoved":true}
```

真实模型示例单独运行，需要环境已有 `DEEPSEEK_API_KEY`：

```sh
pnpm demo
```

或者把凭据保存在仓库根目录被忽略的 `.env` 中：

```sh
pnpm exec node --env-file=../../.env --import tsx examples/run.ts
```

可选 `DSH_MODEL` 默认 `deepseek-flash`。如果设置 `DEEPSEEK_BASE_URL`，它必须是兼容新版 Messages 的 root；旧 OpenAI-compatible `/chat/completions` 网关不能直接使用。示例只向子进程传所需环境，不打印凭据。

[`examples/run.ts`](examples/run.ts)打印 `generation`、`sessionId`、`finalResponse` 和 `turnEnd`。默认请求期望回复 `runtime supervision ok`；示例检查 `turnEnd.kind === completed`，其他终态使进程返回非零。不要只根据 Promise resolve 或非空文本判断模型成功。

## 3. 资源状态怎么变化

| 状态          | 能否接纳新输入   | 含义                                                        |
| ------------- | ---------------- | ----------------------------------------------------------- |
| `idle`        | 可以             | 无活动；可以复用现有 owner，或在下一次显式 run 时创建 owner |
| `running`     | 拒绝 busy        | 一个调用占用整个 runtime slot                               |
| `stopping`    | 拒绝 busy/closed | 正在等待 SDK close 确认回收                                 |
| `quarantined` | 拒绝             | close 失败；保留失败 owner，不能在它旁边创建新进程          |
| `closed`      | 拒绝             | 主动关闭后的终态，不再接单                                  |

[`src/supervisor.ts`](src/supervisor.ts)只有两个资源操作：`run(prompt)` 和 `close()`。构造时不启动进程；`generation` 只是成功构造了多少个 SDK owner，不是持久 runtime ID，也不表示 initialize 已成功。每次 `DeepSeekHarness.run()` 默认创建新 session；本课不演示跨 generation 的会话记忆恢复。

顺序成功调用复用 owner。失败先等 SDK close，成功回收后才允许下一次显式输入触发新 generation。SDK 的 spawn、JSON-RPC framing、EOF/SIGTERM/SIGKILL 都由 SDK 管理，本课不再实现一份。

## 4. 超时为什么不能自动重试

假设模型已经调用工具写入文件，但应用还没有收到终态，连接就断了。重新执行同一 prompt 可能再次执行副作用。supervisor 不知道业务是否完成，所以它只回收资源，并把错误交还调用者；业务层先核对数据库、Artifact 或外部系统，再决定下一步。

本课有三个不同的时限：

| 时限               | 谁负责     | 覆盖什么                                              |
| ------------------ | ---------- | ----------------------------------------------------- |
| initialize timeout | SDK        | profile 启动与握手，示例为 120 秒                     |
| activity timeout   | supervisor | 一次 run 的启动和 receipt-to-idle 等待，示例为 180 秒 |
| close 阶梯         | SDK        | shutdown、EOF grace、信号与退出确认                   |

activity deadline 到期后仍需等待 SDK close。因此它不是完整 `run()` API 的硬返回时间上限；事件循环阻塞也会延后计时器执行。close 抛错时，`AggregateError.errors` 分别保留活动错误和回收错误，slot 进入 quarantine。重复 close 返回同一次回收失败，不悄悄解除隔离。

SDK wire 没有 per-prompt cancel。这里的主动 close 会结束整个 runtime，不能直接拿去关闭共享进程池里某一个租户的 turn。

## 5. 源码事实、观察与限制

**Verified from source：** 新 SDK 通过[公开 launch resolver](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/launch.ts)解析同版本 dsh；[高层 API](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/api.ts)收集 receipt-to-idle；[dispose](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/dispose.ts)拥有进程关闭。

**Observed at runtime：** 2026-09-28 发布包 initialize/close 成功；一次真实模型调用回复 `runtime supervision ok`，`turn/end=completed`。外部 `ps` 观察到的 4 个后代 PID 在退出后均消失。测试命令、机器范围和最终数量见[执行记录](../../docs/reviews/2026-09-28-execution.md)。

**Inference：** 关闭成功是复用这个 slot 的必要条件；业务副作用能否重试仍取决于业务证据。

**未确认：** 真实模型超时中断、真实 close 失败、任意工具后代逃逸、Windows/Linux、进程池公平性、跨租户隔离、持久 session resume。本课的故障顺序只在 keyless tests 中注入，不扩大为这些生产保证。

清理：两个示例只在 SDK close 成功后删除自己创建的临时目录；回收失败时保留目录供排查。keyless tests 不创建 runtime 目录。下一课是[7.2 进程池与容量控制](../../docs/learning-paths/engineering.md)，在独占 lease 与业务 Run 对齐后再增加排队和 worker 数量。
