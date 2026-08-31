# AG-UI DSH Runtime

这是 Stage 5 的 TypeScript full-stack 毕业项目。Task 5A–5D 已完成：SQLite 权威业务状态、DSH runtime manager、Run coordinator、AG-UI projector、持久化 replay/subscription、loopback Fastify API、React/CopilotKit 对话与 Run Inspector，以及固定 rc.2 的真实模型、跨进程 session resume、断线重放和浏览器验收。

本应用是**仅限 loopback 的本地开发集成**。浏览器通过 `agents__unsafe_dev_only` 直连同源 `/api/ag-ui`；它不是生产 CopilotKit 部署，不提供认证、多租户、wire cancel 或 approval。

```text
React + CopilotKit v2 CopilotChatView
  -> fresh HttpAgent per Conversation
  -> loopback Fastify /api/ag-ui
  -> RunCoordinator
  -> SQLite Conversation / Run / RunEvent / Artifact
  -> SourceRuntimeManager
  -> generation-local resume adapter -> official rc.2 SDK JSON-RPC server
  -> stable DSH session root + canonical workspace
```

## 固定工具链

- Node `^22.19 || >=24`
- pnpm `11.7.0`
- TypeScript `6.0.3` strict ESM/NodeNext
- AG-UI client/core/encoder 单一 `0.0.57` closure
- CopilotKit React Core `1.69.3`
- React/ReactDOM `19.2.8`
- Fastify `5.12.1`
- Fastify Static `8.3.0`
- Vite `8.2.2`
- DSH `0.1.1-rc.2` / Cordis `4.0.1`
- official `@deepseek-ai/dsh-sdk-jsonrpc-server` `0.1.1-rc.2` behind a project deployment adapter
- tracked `file:../../labs/cordis-plugin-lifecycle` dependency

项目没有安装 `@ag-ui/server`、`@copilotkit/react-ui` 或 `@copilotkit/runtime`。server/shared/web 使用独立 compiler face；browser face不能导入 `node:sqlite`、DSH runtime 或凭据。

## Keyless 运行

Task 5C 不需要 API key，也不会启动 DSH source runtime。先安装锁定依赖：

```sh
cd projects/ag-ui-dsh-runtime
corepack pnpm install --frozen-lockfile
```

终端一启动显式 fake runtime；终端二启动 Vite：

```sh
corepack pnpm server:fake
corepack pnpm dev:web
```

访问 `http://127.0.0.1:5173`。Vite 只把 `/api` 代理到 `http://127.0.0.1:4317`。fake 模式默认创建 owned temporary state root，关闭后清理 SQLite、workspace 和订阅；若要观察浏览器断开后 Run 继续，可显式加入确定性延迟：

```sh
corepack pnpm exec tsx src/server/entry.ts \
  --runtime fake --host 127.0.0.1 --port 4317 --fake-delay-ms 800
```

Production build 由同一个 Fastify origin 提供静态资源：

```sh
corepack pnpm build
corepack pnpm start:fake
```

server entry 没有默认 runtime；必须显式选择 `--runtime fake|source`。`source` 只接受绝对的 `--source-root` 或 `DSH_SOURCE_ROOT`，并要求匹配的 disposable rc.2 checkout、fresh build attestation 和凭据环境。

## React 与持久 Run

- Conversation 切换会立即卸载旧 chat、abort 旧 snapshot fetch，并用单调 generation 丢弃迟到成功或失败；
- authoritative snapshot 通过运行时 schema 校验后，创建新的 `HttpAgent({ agentId: "dsh", threadId })`，先 `setMessages()`，再挂载 Conversation-keyed `CopilotKit`、`CopilotChatConfigurationProvider` 与 bound `CopilotChatView`；该组合只在提交时调用 `runAgent()`，不会调用 `HttpAgent` 不支持的被动 `connect()`；
- `write_stage4_proof` 使用带 Zod 参数的 named renderer；其他工具由 wildcard card 显示，不注册 frontend tool handler；
- Run Inspector 按 SQLite admission sequence 发现最新 Run，先分页追到 persisted cursor，再使用 fetch SSE；断开时显示 client detached，经 bounded backoff 从最新 cursor 重连，不把 fetch abort 写成 DSH cancellation；
- business / AG-UI timeline 默认可见，raw DSH events 使用 progressive disclosure；terminal 后刷新 artifact metadata，并只链接 immutable `/api/artifacts/:id`；
- bound `CopilotChatView` 的发送/停止入口有明确可访问名称；运行中显示 `Stop receiving; Run continues`，只停止当前浏览器接收。
- stop 或 chat unmount 会 abort 当前浏览器 fetch，但不改变 DSH Run；手工 stop 显示 `Chat stream detached` notice，下一次 submit 或 remount 清除。

## SQLite authority

`AuthoritativeStore` 使用 Node 22.19 共有的同步 `node:sqlite` `DatabaseSync` API，启用 foreign keys、WAL 和 busy timeout。它持有：

- Conversation：业务 ID、当前 DSH session reference/generation、active/blocked recovery state；
- Run：immutable normalized request JSON、fingerprint、status、session reference 和 terminal diagnostics；
- RunEvent：transactional monotonic `(run_id, seq)`、channel/type/payload/timestamp；
- Artifact：immutable BLOB、安全文件名、media type、size 与 SHA-256。

Run admission 在一个 transaction 中递增 Conversation 的 `admission_seq`，再插入 Run 和 queued event；同一毫秒内仍按权威 admission 顺序 hydration。schema v2 会把 v1 Run 按旧 `created_at,id` 稳定迁移后继续单调编号。相同 ID/fingerprint 返回 deterministic conflict metadata；不同 fingerprint 明确失败。startup 把 `running` 转成 `execution_unknown`，写 business terminal 和 schema-valid AG-UI `RUN_ERROR`，并 block Conversation。blocked Conversation 在 acknowledgement 原子旋转 session generation/reference 前拒绝新 Run；ack 不向 terminal Run 追加事件。

## Runtime 与 coordinator

`SourceRuntimeManager` 只接受固定 `dsh-v0.1.1-rc.2` revision、version、built JSON-RPC bin 和 clean tracked/index source。它把状态分成两类：

- 项目 `.runtime/app-state`：owner marker、稳定 audit owner token、DSH sessions、canonical workspace 与 listener evidence；普通 Harness close/restart 不删除；
- upstream ignored `tmp/` generation：生成的 tool-only Cordis composition、复制的 Stage 4 built plugin、HOME、DSH_HOME 与 visible-tools proof；每代 close 后删除。

rc.2 的官方 SDK JSON-RPC server 在首次收到某个 session ID 时固定调用 `ctx.agents.create()`，不会检查同一 JSONL root 中已经 materialize 的 Session。项目自己的 `sdk-resume-adapter.ts` 导入官方 `Config` / `apply`，向它传入一个只覆写 `ctx.agents.create` 的 Context proxy：先用 `sessionPersistence.list()` 查 exact `SessionId`；没有记录时调用原始 `create`，存在记录时把 persisted/requested cwd 都 canonicalize 后要求相等，再调用原始 `agents.resume({ resumeSessionId, agentOptions, setup, signal })`。list、cwd 或 resume 失败都会原样失败，绝不回退 create。其他 Context 与 AgentRegistry 方法绑定原 receiver，官方 wire server 的其余语义不变。

这是 Stage 5 deployment adapter，不属于 Stage 4 plugin，也不修改 upstream。server build 产出 compiled adapter；`SourceRuntimeManager` 在每代生成前固定其 hash，复制到 generation，并在 source revalidation、copy 后与首次 process start 前同时要求源 artifact / 副本保持 regular non-symlink file 且 hash 相等。generated `cordis.yml` 的 SDK row 指向这份 generation-local adapter；官方 SDK server 仍是 upstream dependency-plane attestation seed。

Runtime 还要求 `<upstream>/tmp/hands-on-dsh-runtime-attestation.json`。在明确选择 disposable rc.2 checkout 后运行以下命令；脚本自己执行 fresh frozen install/build，再以 0600 写入 ignored attestation，不调用模型：

```sh
DSH_SOURCE_ROOT=/absolute/path/to/disposable-rc2 \
  corepack pnpm prepare:runtime-attestation
```

Attestation schema v2 固定 HEAD/version、`pnpm-lock.yaml`、built JSON-RPC bin、host platform/architecture/Node major/Node ABI 和 dependency plane。Seed 包含生成 Cordis config 所使用的同一 bare-plugin 定义、runtime bin 所属 package，以及复制进 runtime composition 的 Stage 4 plugin 所依赖的 DSH Tools、Cordis 与 Schemastery host package；收集器按 package-local Node 搜索规则递归 `dependencies`、required peers 与当前平台存在的 optional dependencies，并区分 required peer、optional peer/依赖的 present/absent。每个 package root 排除 `node_modules` 后的全部 regular payload 都记录相对 path、size、mode 和 SHA-256；ESM `import` condition entry 另行固定，因此相对模块、Schemastery `index.mjs` 和 native payload 都进入证明。manager create、首次 process start 与每次 generation/restart 都重新检查 scrubbed Git HEAD/tag/clean index/worktree 和 attestation；检查时已经存在的 missing/stale build/lock/package/payload drift 会拒绝启动。

这份 attestation 是本地单用户学习环境中的 cooperative drift detector，不是抵御同 UID 攻击者的不可变执行快照。最后一次 revalidation 之后直到 runtime 退出，调用方必须保证 upstream source/dependency plane 不被并发 build 或改写；同 UID 在检查与 Node 读取模块之间并发替换文件仍可形成 TOCTOU。若要承诺抵御这种 mutation，需要把已证明的 closure 复制到 generation-local plane、再次验证副本并只从副本启动。`testOnlySourceProbe` 与 `testOnlyHarnessFactory` 只用于可信同进程测试注入，不是接收不可信业务输入的扩展面。

Stage 4 plugin 不从个人路径注入。production 使用 `import.meta.resolve('@hands-on-dsh/cordis-plugin-lifecycle/tool')` 与 `/listener` 解析本项目安装的 tracked `file:` dependency，并检查 package name/version/exports 与 manifest/tool/listener hashes；每代重新验证。`pluginRoot` 只供带 injected source evidence 和显式 test bypass 的临时 fixture。

每次 restart 都在旧 `DeepSeekHarness.close()` 成功后创建新实例。并发首次启动使用同一个 startup promise；失败 handshake 会关闭 Harness 并清理本次 HOME/DSH_HOME/visible proof，下一次可以重试。如果 attempted Harness 关闭失败，manager 保留该实例和 generation，以带 cause 的 `RuntimeTransportUncertainError` 上报，禁止创建第二个进程，直到显式 restart/close 真正完成回收。visible tool probe 必须精确得到 `write_stage4_proof`。环境只传递运行所需 allowlist 与显式 DeepSeek 配置，不继承任意 parent secret。

`RunCoordinator` 从 immutable queued request 恢复，限制最多两个不同 Conversation 并发，同一 Conversation 继续由 SQLite active-run unique index 串行化。同步 SDK callback 先持久化原始 DSH notification，再投影 AG-UI；首次失败后仍尝试 raw authority，但停止后续 projection，并继续 drain 到 whole-agent idle。raw authority 缺口按 unknown/block 处理，不能降级成普通 failed。共享 transport loss 会 latch runtime unavailable，只结算 coordinator 当前拥有的 active Runs 为 `execution_unknown`，保留 pending Run 为 queued；idle restart 成功后才恢复 pump。此后 raw evidence 可继续记录，但不会在 AG-UI `RUN_ERROR` 后追加投影事件。

Fastify `preClose` 使用有界 grace：先停止 admission，允许 active Run 自然 drain；超时则先把 coordinator-owned active Runs 标为 unknown，再通过 runtime `shutdown()` 关闭整个 transport/process 并回收。pending Run 不会在 shutdown 期间启动。terminal persistence 或 cleanup 的 fire-and-forget 异常进入 fatal latch，停止新 admission，而不是形成 unhandled rejection。

Artifact 不信任 runtime 返回 path/bytes。coordinator 从 exact root `session.event: tool/call` 取得受限 cleanup identity，重新计算 `sha256("stage5-proof-v1\\0" + session + "\\0" + callId)`，检查 0700 非 symlink partition 与 0600 regular proof，比较 accepted prompt bytes。成功、failed、unknown 和 deadline 终态都会在可验证 proof 存在时先把 immutable BLOB/hash 写入 SQLite，再清理 owned file/partition。Artifact 写入失败时唯一 proof partition 会作为 quarantine 保留并触发 fatal latch，不能先删证据。

## AG-UI 与 HTTP

`AguiProjector` 按 root `(session, turn, step)` 管理状态，覆盖 step、streamed/committed text、tool call/result 和 subagent lifecycle。streamed text 必须与 committed text 精确一致；tool call 必须属于同一步 committed assistant message，每个 call ID 唯一，并在 step end 前取得同一步、boolean `isError` 的唯一 result。所有产出经过 `EventSchemas`，完整 fixture 再通过 `verifyEvents`。只有 store 的 `startRun` / `finishRun` / unknown transition 产生 AG-UI terminal。

Fastify 只允许 loopback peer；`listenLocal()` 默认绑定 `127.0.0.1`，未显式 insecure override 时拒绝非 loopback host。主要接口：

- `POST /api/ag-ui`：只接受 JSON 与新 Run，EventEncoder SSE；duplicate 返回 409 和 detail/replay links；
- `GET /api/conversations/:id`：SQLite-derived Conversation、Run 与 message hydration snapshot；
- `GET /api/runs/:id/events`、`GET /api/runs/:id/stream`：page 与 `after` / `Last-Event-ID` business replay；
- `GET /api/artifacts/:id`：immutable bytes 与 download headers；
- `GET /api/capabilities`、`GET /api/health`：明确 false cancel/approval 与不含 PID 的 last-observed health；
- runtime restart 与 execution-unknown acknowledgement。

SSE subscriber 只从 SQLite pull page，内存只持有 revision waiter。Conversation hydration 先捕获每个 Run 的 event high-water，再分 250 条读取到该上界，不使用 10,000 条截断。断线/abort 会移除 waiter，但不取消 Run；coordinator shutdown 的全局 AbortSignal 会关闭所有 iterator、waiter 和正在等待 drain 的 HTTP write，pending Run 仍保持 queued。write backpressure 同时监听 drain、close、error 与 AbortSignal。

## Plugin extension

Stage 4 tool 的 `partitionMode` 默认 `single`，保持原来的固定 `stage4-proof.txt`。`call` 模式要求 Agent，把 `stage5-proof-v1\0<session>\0<callId>` 做 SHA-256，使用 64 位 hex call partition；模型仍不能提供 path/command。

Listener 保留默认 exact session，并支持不需要 rootSessionId 的 `sessionMode: all`。每个 session 有独立 live→durable correlation slot；不同 session 可并发，同 session 在上一对 durable 完成后可接受下一对。owner sidecar、0600 audit、reload 和 post-dispose 语义保持不变。

## 真实 rc.2 验收（2026-08-31）

真实 gate 使用 clean `dsh-v0.1.1-rc.2` / `b150a551` disposable checkout 和 schema-v2 attestation。首次运行暴露 stock SDK JSON-RPC server 无条件 fresh-create、不能跨进程 resume 的缺口；项目 adapter 以官方 `agents.resume()` 修复后，从全新 state root 重跑通过。

- 两个业务 Conversation 对应不同 DSH session reference；四个真实 Run 全部 succeeded；
- 每个 Run 恰好一个 root tool call/result、一个 immutable Artifact，下载字节逐字等于 accepted prompt；
- audit 对每个 call ID 都是 `live,durable` 两行，tool-health violation 为 0，visible tools 精确为 `write_stage4_proof`；
- idle restart 关闭 generation-1 runtime，server PID 保持不变；generation 2 按需拉起新 runtime，A 的 DSH session reference 不变；
- A 的 JSONL 只有一个 header，turn 连续为 `[1,2,3]`；模型在进程重启后准确回忆 `ONYX-842`；
- 浏览器在 Run 仍为 running 时停止 AG-UI 接收，显示非 cancel 提示；business SSE cursor 随后到达同一 terminal，Refresh 只恢复一次缺失消息；
- desktop 与 375px 均无横向 overflow，Axe WCAG A/AA 为 0 violations / 0 incomplete；
- 最终 SIGTERM exit 0，观察到的 server→runtime 两级进程与 generation 目录消失，端口关闭。

该证据证明项目自有 adapter + 固定本地 composition，不证明 stock rc.2 单独具备 SDK 跨进程恢复，也不扩大为通用 process-tree supervisor 保证。

## 验证

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm test:web
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm build
corepack pnpm smoke:server
corepack pnpm list -r @ag-ui/client @ag-ui/core @ag-ui/encoder
```

当前 project suite 为 19 files / 117 tests。`smoke:server` 从 project 之外的 cwd 导入 built resume-adapter ESM，再启动 built entry，验证 fake runtime、health、HTML、hashed asset 与 SIGTERM shutdown。Store tests 必须分别在 Node 22.19+ 和 Node 24 执行。生成的数据库、runtime state、browser artifacts、dist 和 node_modules 都被忽略。

## 尚未实现

- production auth、multi-tenancy、wire cancel、approval
- 对同 UID 并发改写者不可变的 runtime dependency snapshot
