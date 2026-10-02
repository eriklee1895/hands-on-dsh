# TypeScript SDK：从公开 profile 到底层 receipt-to-idle

本教程用四个独立示例学习 DSH TypeScript SDK：启动发布版 runtime、复用一个 session、读取通知并核对工具产物，以及直接使用底层 JSON-RPC client。先运行最小示例，再阅读相应源码。

## 版本与前置条件

- npm SDK/runtime：精确锁定 `0.1.7-rc.2`，上游 tag `dsh-v0.1.7-rc.2`，commit `477b4f420553e8a52c2fbccc464d7561b239c443`。
- Node：`^22.19.0 || >=24.0.0`；pnpm：`12.3.4`。项目使用 strict ESM/NodeNext，`node --import tsx` 运行 TypeScript。
- 需要可用的 `DEEPSEEK_API_KEY`。可选 `DEEPSEEK_BASE_URL` 必须兼容这个发行版的 Messages 请求。下面的命令从本目录执行，并通过仓库根目录被忽略的 `.env` 向父进程提供凭据。

```sh
cd tutorials/typescript-sdk
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

发布版 `@deepseek-ai/dsh-sdk-client` 的默认 resolver 从同版本 `@deepseek-ai/dsh` 包定位 CLI；`src/runtime-launch.ts` 只传公开 `profile: "sdk-minimal"`、独立的 `dshHome` 和 `processCwd`。每次示例创建自己的 `.runtime/<example>-<random>/workspace`，并用替换环境只传必要的路径、locale、证书和 DeepSeek 凭据。可用 `--patch <绝对路径>` 追加 profile patch。四个示例都有 `--help`、`--prompt`、`--session`、`--deadline-ms`；示例 02 另有 `--second-prompt` 和 `--nonce`；默认运行由同版本 resolver 定位发布版 CLI，profile 始终是 `sdk-minimal`。

`sdk-minimal` 配置允许 Agent 使用工具并具有 `danger-full-access` 执行策略。临时 workspace 和 home 用于确定示例产物的位置，并不限制进程读取或修改其他路径。真实模型运行应放在可丢弃的开发环境。

## 1. 显式启动高层 SDK

```sh
node --env-file=../../.env --import tsx examples/01_explicit_launch.ts
```

`DeepSeekHarness` 懒启动同版本 runtime，完成 initialize 和一次 prompt。输出包含 session ID、最终文本及事件数。示例检查最后一个 `turn/end.reason.kind` 为 `completed`；只得到一个 resolved Run 不代表模型完成。

## 2. 复用 runtime 和 session

```sh
node --env-file=../../.env --import tsx examples/02_reuse_session.ts
```

同一个 `DeepSeekHarness` 和 `HarnessSession` 连续执行两个 turn。默认代号为 `amber`；`--nonce SAFFRON` 会把默认第一轮 prompt 改为记住 `SAFFRON`。第二轮回复经过首尾空白去除与 Unicode NFKC 规范化后，必须与所选代号完全相等；`chamber` 或 `memory: amber` 都不能证明回忆成功。每轮还必须以 `completed` 结束。自定义 `--prompt` 或 `--second-prompt` 改变代号时，应同时传入匹配的 `--nonce`，并让第二轮只回答代号原文。这个例子验证同一进程内复用，不演示关闭后重新启动并恢复 session。

## 3. 通知投影与外部产物

```sh
node --env-file=../../.env --import tsx examples/03_notification_stream.ts
```

`onNotification` 接收 session tree 通知。`NotificationProjection` 只使用 root session 的已提交 `assistant/message`，把 `rootText` 更新为最后一条消息；child 和 foreign session 文本不会进入最终答案。它还计数 root 工具事件、subagent 及运行状态。本版 SDK server 不下发实时 `agent/assistant-stream`，因此这个示例不宣称逐 token 输出。

示例要求工具写入 `dsh-typescript-proof.txt`，随后由 Node 直接读取文件，与 `hands-on-dsh TypeScript SDK proof\n` 的 34 个 UTF-8 字节逐字节比较。模型说“已创建”不构成验证。关闭 runtime 成功后，示例删除自己创建的状态目录。

## 4. 底层 HarnessClient

```sh
node --env-file=../../.env --import tsx examples/04_low_level_client.ts
```

示例显式执行 `start → initialize → subscribeSessionTree → prompt → receipt → root idle → close`。`session/prompt` 返回 message ID，表示 inbox receipt；它本身不是完整 turn。底层循环忽略 matching receipt 之前的通知，只从 receipt 后收集 root `assistant/message`，且在下一次 root `idle` 前检查 `turn/end=completed`。child 和 foreign 消息不充当 root 最终回答；异常 EOF 会使订阅拒绝。

四例都有包住整个活动的 deadline。单个 JSON-RPC request timeout 不覆盖 receipt-to-idle 的全部等待；到期时关闭拥有进程的 harness/client。清理只有在 SDK close 确认后执行，关闭失败时保留状态目录供排查。

## Keyless 测试与真实观察

`tests/fixtures/fake-runtime.mjs` 是显式传给公开 `dshBin` 选项的测试 CLI，要求规范的 `--profile sdk-minimal` 参数；应用示例使用默认同版本 resolver。测试验证 profile 选项、替换环境、ownership cleanup、两轮记忆、matching receipt 前后顺序、root/child/foreign 过滤、精确工具字节、EOF、协议错误、deadline 和强制回收。fixture 生成已提交的消息事件；它不模拟未下发的实时流。

2026-09-28 在 Node 26.7.0、pnpm 12.3.4、macOS arm64 上，`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 与四个真实入口分别执行。真实结果：示例 01 收到“TypeScript SDK 已连接。”；示例 02 的两轮回复包含 `amber`；示例 03 记录 1 次 tool call/result、精确 34 字节 proof；示例 04 收到 runtime identity 和 matching receipt，在 root idle 后得到最终回答。外部进程采样分别运行四例，捕获后代 PID 数量为 2、2、12、2；各父进程退出后对应 PID 均不存在，且示例 03 的 proof 验证成功。这些是正常关闭的观察，不扩展为任意异常情况下所有后代都会退出的保证。

## 源码与限制

固定版本的[公开 launch resolver](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/launch.ts)、[高层 API](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/api.ts)、[底层 client](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/client.ts)和[server 通知转发](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/server/src/server.ts)是本教程的源码依据。旧版行为与日期分开的记录见[迁移审查](../../docs/reviews/2026-09-28-upstream-refresh.md)。

这是单进程学习示例，不提供多租户隔离、进程池、持久任务编排或 wire 级取消。生产应用需要把业务 Run/Task 的状态与 DSH Session/Turn 分开，并决定超时后的副作用核对与重试策略。下一步可读[Runtime Supervision 实验](../../labs/runtime-supervision/README.md)，再比较[Python 与 TypeScript SDK](../../docs/comparisons/python-vs-typescript-sdk.md)。
