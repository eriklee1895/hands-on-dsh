# TypeScript SDK：从显式 runtime 到底层 receipt-to-idle

这是一组独立的中文 TypeScript 教程。目标不是再手写一套 JSON-RPC client，而是用 DSH 已发布的 TypeScript SDK 学会四件事：显式拉起 runtime、复用 session、投影通知、理解底层 receipt-to-idle 结算。

本教程锁定以下版本，不跟随 `latest` 漂移：

- DSH SDK/runtime：`0.1.1-rc.2`
- upstream tag：`dsh-v0.1.1-rc.2`
- upstream commit：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Node：`^22.19.0 || >=24.0.0`
- pnpm：`11.7.0`

## 先理解运行边界

TypeScript 包 `@deepseek-ai/dsh-sdk-client` 提供高层 `DeepSeekHarness` 和底层 `HarnessClient`，但不像 Python 包那样携带并自动解析一个 bundled runtime。本教程因此显式指向一份已经构建的 DSH upstream checkout：

```text
TypeScript example
  -> @deepseek-ai/dsh-sdk-client
  -> child process: node <upstream>/packages/examples/jsonrpc-demo/lib/bin.js
  -> <upstream>/examples/jsonrpc-agent/minimal.cordis.yml
  -> stdio JSONL / SDK JSON-RPC
```

`src/runtime-launch.ts` 是唯一的真实 runtime 启动解析器。它在创建任何运行状态前验证：源码绝对路径、两个 tracked-clean 检查、HEAD、tag、根 package 版本、built bin 和配置文件。Git 子进程使用清理后的环境和显式 `git -C <source>`，父进程的 `GIT_DIR`、`GIT_WORK_TREE` 或 `GIT_CONFIG*` 不能把检查重定向到另一个仓库。无关的 untracked 文件不会使检查失败。

每次调用都会创建一个新的 `.runtime/<example>-<random>/`，其中包含独立的 workspace、session root、HOME 和 DSH_HOME。传给子进程的 `env` 是替换环境：只保留运行所需的 PATH、临时目录、locale、证书变量，再加入 DeepSeek 凭据和固定 DSH 配置。代理、云凭据、其他 secret、`DSH_CORDIS_CONFIG` 都不会继承。

## 安全警告

本教程使用 upstream 的 `minimal.cordis.yml`。该配置挂载持久 Bash 和编辑工具，并把 sandbox policy 固定为 `danger-full-access`。

`.runtime/.../workspace` 是任务目标目录，不是安全隔离边界。示例 03 要求模型只写该目录，但 runtime 本身有能力访问目录外。真实模型运行只支持 macOS/Linux，并且必须在一次性 checkout、容器或你明确愿意让 Agent 操作的机器环境中执行。

## 安装

从本目录运行：

```sh
corepack pnpm install --frozen-lockfile
```

项目使用 strict ESM/NodeNext。TypeScript 文件通过 `node --import tsx` 执行，不依赖 Node 内建 type stripping。`skipLibCheck` 只避开 rc.2 发布包的传递声明缺少可选 peer 类型的问题；本教程自己的 `src/`、`examples/` 和 `tests/` 仍在 `strict` 下检查。

## 准备 upstream runtime

使用一份可丢弃的 DSH checkout，并把它切到固定 tag。运行真实示例之前执行：

```sh
git rev-parse HEAD
git rev-parse 'dsh-v0.1.1-rc.2^{commit}'
git diff --quiet
git diff --cached --quiet
corepack pnpm install --frozen-lockfile
corepack pnpm run build
git diff --quiet
git diff --cached --quiet
```

两个 revision 输出必须都是 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。构建后再次检查 tracked worktree 和 index，不能只根据 `lib/bin.js` 已存在就推断产物来自正确源码。

根 `.env` 只由示例的父 Node 进程读取。runtime 子进程不会搜索本仓库根 `.env`，也不会继承整个父环境。运行形式如下：

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness \
  node --env-file=../../.env --import tsx examples/01_explicit_launch.ts
```

也可以用 `--source-root <绝对路径>` 覆盖 `DSH_SOURCE_ROOT`。所有示例都有 `--help`，并支持 `--prompt`、`--session` 和 `--deadline-ms`；示例 02 另有 `--second-prompt`。

高级 plugin gate 可用 `--config <绝对路径>` 覆盖 minimal composition。launcher 只接受位于同一固定 upstream checkout 的 `tmp/` 下、真实存在且经该仓库 `git check-ignore` 确认 ignored 的文件；relative、checkout 外部或 tracked 配置都会在创建 runtime state 前拒绝。该能力用于独立 ignored composition，不修改 checked-in minimal config。

## 四个渐进示例

### 1. 显式启动高层 SDK

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness \
  node --env-file=../../.env --import tsx examples/01_explicit_launch.ts
```

观察 source revision、session ID、最终文本和事件数量。高层 `DeepSeekHarness.start()` 不返回 `serverInfo`；wire handshake 的固定 identity 会在示例 04 中看到。

### 2. 复用 runtime 和 session

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness \
  node --env-file=../../.env --import tsx examples/02_reuse_session.ts
```

同一个 `DeepSeekHarness` 只拥有一个懒启动的 runtime 子进程；同一个 `HarnessSession` ID 让第二个 turn 读取第一轮 session 历史。进程复用和 session 记忆是两个不同事实。

### 3. 通知投影与外部产物

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness \
  node --env-file=../../.env --import tsx examples/03_notification_stream.ts
```

callback 收到 session tree 的通知。`NotificationProjection` 只把 root session 的 `assistant/chunk` 中 `text-delta` 增量加入 `rootText`，不再重复拼接随后提交的 `assistant/message`；child 文本也不会进入 root 输出。高层 `RunResult.finalResponse` 和示例 04 的底层结算仍从 committed `assistant/message` 取最终答案。投影同时统计 tool、subagent 和 running/idle 事件。示例独立读取 proof 文件并比较精确字节，不把模型回复当作工具成功的证明。关闭 runtime 并完成字节验证后才删除该次 `.runtime` 状态。

### 4. 底层 HarnessClient

```sh
DSH_SOURCE_ROOT=/absolute/path/to/deepseek-harness \
  node --env-file=../../.env --import tsx examples/04_low_level_client.ts
```

该示例显式执行 `start -> initialize -> subscribe -> session/prompt -> shutdown`。`session/prompt` 返回的 message ID 只是 inbox receipt identity，不是完整 Run。receipt 是 `next-turn` inbox 的插入事件；真正运行随后记录从 1 开始的 `turn/start`、删除该项的 claim splice、从 1 开始的 `step/start` 和 model-visible `user/message` surface。客户端忽略 matching receipt 之前的所有通知；看到 receipt 后，只在下一次 root `idle` 才结算。

四个示例都用外层 receipt-to-idle deadline。`requestTimeoutMs` 只限制单次 JSON-RPC 请求，不能替代完整 turn 的 deadline；SDK JSON-RPC rc.2 没有 cancel，所以 deadline 到期时必须关闭拥有 runtime 的 harness/client。

## Keyless 验证

测试使用 `tests/fixtures/fake-runtime.mjs`，不会读取真实 API key，也不会启动 DSH upstream 或真实模型。fake runtime 使用 rc.2 的 JSONL envelope，并在 `session/prompt` response 之前先排入 matching inbox receipt；请求并发处理，因此挂起的 prompt 不会阻塞 shutdown。它为每个 session 维护独立单调 seq，并生成本教程读取的完整 turn/step、chunk/message、tool call/result、surface 和 source-link 字段。

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
```

覆盖范围包括：精确依赖 pin、scrubbed Git/source gate、替换环境、安全回滚与 ownership cleanup、懒启动与复用、两轮记忆、完整 transcript、receipt 前过滤、root/foreign/descendant 过滤、工具产物、`-32603`、malformed result、request timeout、EOF、协作关闭、强制回收和幂等 close。四个 CLI 除了 `--help`，还分别通过 fake source/runtime 完成成功编排、产物验证、状态清理和凭据/本地路径脱敏。

## 真实 rc.2 验收记录（2026-08-31）

真实 gate 使用一份创建前确认不存在的 disposable DSH worktree。fresh `pnpm install --frozen-lockfile` 和完整 `pnpm run build` 成功；build 前后 `HEAD`、tag、package version、tracked worktree/index 和两个 runtime artifact 均满足本教程 gate。

从本目录使用根 `.env` 逐个执行四个入口，命令形式保持一致：

```sh
DSH_SOURCE_ROOT=<disposable-rc2-worktree> \
  node --env-file=../../.env --import tsx examples/<example>.ts \
  --session <unique-session> --deadline-ms <bounded-ms>
```

| 示例 | 真实观察                                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | 高层调用报告精确 rc.2 revision/version，并得到 terminal 中文回复                                                                                                                          |
| 02   | 同一 harness/runtime 的两轮 session 在第二轮逐字返回唯一 nonce，进程未替换                                                                                                                |
| 03   | 运行前 proof 不存在；外部监视器在 cleanup 前核对 34 字节和 SHA-256 `aad7ecb3fafcc8aedefd175b87d6629d49f8afbe7e38b3563247fc059e1accab`；root 投影记录 2 次 tool call/result、0 个 subagent |
| 04   | wire identity 为 `deepseek-harness-sdk-runtime@0.0.1`，返回非空 matching receipt、精确 root answer，并在下一次 root idle 后结算                                                           |

每次启动都由外部进程表捕获 runtime 的 PID/PPID/PGID。示例 03 还观察到一个独立 PGID 的工具 descendant；正常退出后逐 PID 确认 runtime 和该 descendant 均消失。四次成功运行后 `.runtime` 都没有残留。输出检查未发现凭据或未脱敏的 source/runtime/个人绝对路径。

这只证明这四次正常 shutdown。rc.2 client 直接拥有 runtime 子进程，但没有 detached process-group handle；不能据此声称异常关闭时能强制清理任意 descendant。

## 源码对应

这些结论对应固定 revision 中的入口：

- 高层 API：`packages/sdk/client/src/api.ts`
- 底层 client、notification subscription：`packages/sdk/client/src/client.ts`
- 关闭与强制回收阶梯：`packages/sdk/client/src/dispose.ts`
- wire 类型：`packages/sdk/protocol/src/types.ts`
- JSON-RPC server：`packages/sdk/server/src/server.ts`
- runtime bin：`packages/examples/jsonrpc-demo/src/bin.ts`

## 限制

- 这是学习用单进程 client，不是 runtime pool 或生产 supervisor。
- rc.2 SDK JSON-RPC 没有 wire cancel/approval；不要虚构这些控制能力。
- SDK 的 subprocess dispose 阶梯直接拥有并回收 runtime 进程。真实环境是否存在 runtime 自己留下的孙进程，仍要用进程表做外部验证。
- fake runtime 证明 client 语义与故障处理，不证明 provider、模型或工具在真实 runtime 中可用。
- 官方网站目前没有与 Python SDK quickstart 对等的 TypeScript quickstart；本教程以固定发行包类型和对应 tag 源码为真源。
