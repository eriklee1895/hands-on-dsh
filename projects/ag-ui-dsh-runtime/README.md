# AG-UI DSH Runtime

> 固定版本（2026-09-29）：npm `@deepseek-ai/dsh@0.1.7-rc.2`、同版本 TypeScript SDK 与 Cordis `4.0.4`；上游源码为 [`dsh-v0.1.7-rc.2`](https://github.com/deepseek-ai/deepseek-harness/tree/477b4f420553e8a52c2fbccc464d7561b239c443)。

这是一个可运行的 TypeScript AG-UI 学习项目。Fastify 提供同源 API 与静态页面，React/CopilotKit 展示对话和 Run Inspector；应用 SQLite 保存权威 Conversation、Run、RunEvent 和不可变 Artifact。DSH Session 是 runtime 引用，浏览器连接与模型回复都不是业务状态真源。本项目只绑定 loopback，没有认证、多租户、wire cancel 或 approval。

```text
React + CopilotKit / HttpAgent
  -> loopback Fastify /api/ag-ui
  -> RunCoordinator -> SQLite Conversation / Run / RunEvent / Artifact
  -> PackageRuntimeManager -> public @deepseek-ai/dsh sdk-minimal profile
  -> ordered application + proof-plugin patches
  -> project resume adapter around official SDK JSON-RPC server
  -> persistent Harness home / Session history + generation-local plugin code
```

## 固定工具链

- Node `^22.19 || >=24`、pnpm `11.7.0`、TypeScript `6.0.3` strict ESM/NodeNext。
- AG-UI client/core/encoder `0.0.57`、CopilotKit React Core `1.69.3`、React/ReactDOM `19.2.8`、Fastify `5.12.1` 与 Fastify Static `8.3.0` 保持原版本。
- 同版本 `@deepseek-ai/dsh`、`@deepseek-ai/dsh-sdk-client` 和相关 DSH 包 `0.1.7-rc.2`，Cordis `4.0.4`。
- Stage 4 工具来自 tracked `file:../../labs/cordis-plugin-lifecycle` 的 `./tool`、`./listener` 出口。

本项目不安装 `@ag-ui/server`、`@copilotkit/react-ui` 或 `@copilotkit/runtime`。server/shared/web 有独立 compiler face；browser face不接触 `node:sqlite`、DSH runtime 或模型凭据。

## 安装与运行

先在 Stage 4 lab 构建文件依赖，再回到本项目安装。命令从 `projects/ag-ui-dsh-runtime` 执行：

```sh
cd ../../labs/cordis-plugin-lifecycle
corepack pnpm install --frozen-lockfile
corepack pnpm build
cd ../../projects/ag-ui-dsh-runtime
corepack pnpm install --frozen-lockfile
corepack pnpm build
```

Keyless fake 模式使用临时业务状态；关闭后删除：

```sh
corepack pnpm server:fake
corepack pnpm dev:web
```

访问 `http://127.0.0.1:5173`。Vite 只把 `/api` 代理到 loopback Fastify `:4317`。也可以通过 `corepack pnpm start:fake` 从 production build 同源提供页面与 API。server entry 必须显式选择 `--runtime fake|package`；没有 source checkout 模式。

真实 package 模式要求本地 `DEEPSEEK_API_KEY`、已构建的 server 和可丢弃 workspace。以下命令从本项目目录加载仓库根目录的私有 `.env`，在 loopback `:4317` 同源提供页面与 API：

```sh
node --env-file=../../.env dist/server/server/entry.js \
  --runtime package --host 127.0.0.1 --port 4317 --serve-web
```

默认业务状态位于 ignored `.runtime/app-state`。可用 `--state-root /absolute/disposable/path` 选择独立状态；不要把生产或个人 Session 数据交给本地 demo。`corepack pnpm start:package` 适用于凭据已经由 shell 注入的情况。

## 运行时组成和恢复

`PackageRuntimeManager` 让公开 npm `dsh --profile sdk-minimal` 负责启动。它通过两个有序 `--patch` 层禁用默认 shell、保留 `includeRuntimeContext: false`、启用编译后的 SDK resume adapter，再加入唯一可见的 `write_stage4_proof`、审计 listener 和工具清单检查。工具描述与参数 schema 由 Stage 4 包拥有；补丁不复制其源码。`sdk-minimal` 的 `danger-full-access` 策略不是 sandbox，因此只能用隔离 workspace 运行。

项目的 `.runtime/app-state` 保存 0700 owner marker、SQLite、workspace、evidence 与独立 `dsh-home/sessions`。每个 generation 只保存复制的 plugin/adapter、补丁、临时 HOME 和可见工具证明；关闭并确认 runtime 退出后才删除 generation。server build 与 installed Stage 4 文件的路径、出口和 hash 会在 generation 准备及首次启动前核对。关闭失败会隔离 owner，不会在旧进程旁创建新 generation；restart 和 shutdown 期间拒绝新 Run。项目不再依赖 upstream source bin 或本地 source attestation。

stock SDK JSON-RPC server 对新见到的 Session ID 仍调用 `agents.create()`。本项目的 deployment adapter 只代理这个调用：先用 `sessionPersistence.stat(id, { signal })` 读取 exact persisted header；没有记录才 create，存在记录则把持久化与请求的 cwd 都 canonicalize 并核对，然后调用 `agents.resume()`。stat、cwd 或 resume 失败不会回退 create。它不是 stock SDK 原生跨进程 resume，也不改变官方 server 的其他 wire 行为。

## 业务状态、事件与产物

`AuthoritativeStore` 使用 Node `DatabaseSync`、WAL 和 busy timeout。Run admission 在一个 transaction 中分配 Conversation 内单调序号、保存 immutable request/fingerprint 并写入 queued event；同一 Conversation 只有一个 active Run，两个不同 Conversation 可并发。startup 对历史 `running` 标为 `execution_unknown` 并 block Conversation；acknowledgement 原子旋转 DSH session reference，不能重试未知外部副作用。已有 SQLite schema v2 和旧 RunEvent 按原 seq/type/payload 重放，本次 SDK 升级没有业务 schema bump。

新 DSH V4 的 `assistant/message` 是已提交消息。`AguiProjector` 从其文本块生成一组 AG-UI `TEXT_MESSAGE_START/CONTENT/END`，不伪装逐 token 输出；tool call 必须对应同一步已提交的 assistant call，V4 `tool/result` 的 call ID 来自 `event.data.message.toolCallId`。原始 DSH notification 先写入 SQLite，再投影 AG-UI；最后一个 root `turn/end.reason.kind` 只有为 `completed` 才能把业务 Run 标为 succeeded。模型以 `max-tokens`、`error` 等原因结束时 Run failed，可验证的 proof 仍快照为 Artifact。

Artifact 不信任模型自述或 runtime 返回的字节。coordinator 从 root `tool/call` 获取 call ID，计算 `sha256("stage5-proof-v1\0" + session + "\0" + callId)` 目录，验证 0700 partition、0600 regular proof 与 accepted prompt 的精确字节，再把 BLOB/hash 原子写入 SQLite。audit 对同一 call ID 记录 `live,durable`；health 中任何 violation 都需排查。失败或未知终态尽可能保留可验证 proof；Artifact 写入失败时 quarantine 唯一原件并停止新 admission。

## AG-UI 与 HTTP

主要接口：

- `POST /api/conversations`、`GET /api/conversations/:id`：创建业务 Conversation 与 SQLite hydration snapshot。
- `POST /api/ag-ui`：AG-UI `RunAgentInput`，新 Run 输出 SSE；重复 Run ID 返回 409 和 replay 链接。
- `GET /api/runs/:id`、`GET /api/runs/:id/events`、`GET /api/runs/:id/stream`：权威 Run、分页事件和持久游标 business SSE。
- `GET /api/artifacts/:id`：下载 SQLite 的 immutable BLOB。
- `POST /api/runtime/restart`、`POST /api/conversations/:id/acknowledge`：idle runtime generation restart 与不确定执行确认。
- `GET /api/capabilities`、`GET /api/health`：明确 false 的 cancel/approval 与不含 PID 的 last-observed 健康信息。

AG-UI subscriber 断开只移除浏览器 waiter，Run 继续到终态。Run Inspector 用 SQLite cursor 先分页再订阅，断线后按确认位置重连；浏览器 stop 只停止接收，不是假装 wire cancel。Fastify `preClose` 停止 admission，给 active Run 有界 drain；超时按 unknown 结算并关闭整个 transport。SQLite 终态在 AG-UI terminal 之前提交。

## 验证

```sh
corepack pnpm test
corepack pnpm test:web
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm build
corepack pnpm smoke:server
corepack pnpm list -r @ag-ui/client @ag-ui/core @ag-ui/encoder
```

`smoke:server` 从外部 cwd 启动 built fake entry，验证 loopback health、静态 HTML/asset、adapter ESM 和关闭。真实模型 gate 需要私有本地 `.env`；它在临时状态内创建两个 Conversation、四个 Run，验证每个下载的精确 Artifact 字节、大小与 SHA-256、同 Session 跨 generation 的随机 nonce 回忆、AG-UI detach 后 business replay cursor、audit 对应及进程清理。nonce 验收只看最后一条 root 已提交 assistant 消息，去除首尾空白后必须与 nonce 完全相等；第二轮 prompt 和工具产物均不得包含 nonce：

```sh
node --env-file=../../.env scripts/real-package-e2e.mjs
```

2026-09-29 的固定版本实跑结果：两个 Conversation、四个 succeeded Run、四个精确 BLOB 下载及大小/hash 校验、四组 `live,durable` audit；generation 1→2 后同一 Session 的最后一条 root 已提交回复恰好等于未在第二轮 prompt 或工具文件中泄漏的随机 nonce。断开的 AG-UI 请求仍到达 business terminal，游标重放得到 32 个后续 ID；外部观察到的两个 runtime 后代进程在关闭后都已退出。这是项目 adapter 与此机器的运行证据，不扩大成 stock SDK 的恢复保证。

## 生产限制

- 无认证、租户隔离、远程 sandbox、wire cancel、approval 或多进程协调；不要绑定公网。
- `sdk-minimal` 默认权限宽；虽然本项目关闭默认 shell 并检查可见工具清单，插件和 runtime 仍拥有进程权限。
- 本地 hash/regular-file 检查是合作式漂移检测，不是对同 UID 并发替换者的不可变依赖快照。
- Artifact、Session 与业务 Run 的恢复层级不同；任意旧版 Session 文件不因业务事件可重放就自动具备跨版本模型历史恢复能力。
- 2026-08-31 旧 `0.1.1-rc.2` source-mode 验收只作为历史，不能替代上述固定新版测试。
