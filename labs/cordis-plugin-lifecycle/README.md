# Cordis Plugin Lifecycle：proof journal 与公开 Agent composition

这是一个原创的 DSH plugin 实验，用 proof journal 练习 Cordis Service、`inject`、`ctx.effect()`、typed event、waterfall、Loader/HMR，以及真实 Agent 的工具执行与 Session 提交。工具与 listener 同时作为可打包的子路径提供给其他项目；本 lab 自己的模型运行使用发布版 `dsh --profile sdk-minimal` 与有序 patch，不启动私有 demo bin。

## 固定版本与安装

- DSH npm 包：精确 `0.1.7-rc.2`；上游 tag `dsh-v0.1.7-rc.2`、commit `477b4f420553e8a52c2fbccc464d7561b239c443`。
- Cordis `4.0.4`；同一 tag 的 Include `1.0.9`、Loader `1.0.5`、HMR `1.0.19`、Timer `1.1.6`、Schemastery `3.18.4`。
- Node `^22.19.0 || >=24.0.0`，pnpm `12.3.4`；本次验证环境是 Node 26.7.0、macOS arm64。

从本目录运行：

```sh
cd labs/cordis-plugin-lifecycle
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
pnpm pack:smoke
```

`build` 输出同一个 package 的 `./tool` 与 `./listener` subpath。pack smoke 用 tarball 安装一个新 consumer，通过 plain Node 的 Loader 加载两条 subpath，读取实际 proof 字节；不依赖 tsx 或本目录源码。导出名、配置字段和 proof/audit/health 文件语义保持稳定，供[AG-UI 项目](../../projects/ag-ui-dsh-runtime/README.md)复用。

## 生命周期实验

`ProofJournalService` 由 provider 提供为 `ctx.proofJournal`，consumer 用 `inject: ['proofJournal']` 声明需求：provider 卸载后 consumer cleanup 并进入 PENDING，再加载时重新激活一次。另一个 resource plugin 在 effect 中拥有 timer、watcher 和文件描述符；dispose 等待异步清理并保留外部 proof artifact。waterfall observer 调用 `next()` 把决策交给下游，显式 veto 则短路。Loader/HMR 测试覆盖稳定 ID 的文件与配置 reload，以及缺失依赖时的 PENDING 诊断。

`tests/agent-loop.test.ts` 用固定脚本模型驱动真实 `ctx.agents.create()` / AgentLoop，验证模型请求可见工具 schema、精确 proof、live `tools/result`、durable `tool/result` 和同一 call ID。当前 V4 durable 结果的 ID 在 `event.data.message.toolCallId`；结果内容是模型可见的文本块，不能再从旧版的 `message.content[0].toolCallId` 读取。

## 可复用的工具与 listener

`@hands-on-dsh/cordis-plugin-lifecycle/tool` 注册 `write_stage4_proof`。模型参数只有 `content`，没有文件路径或命令；配置拥有 `workspaceRoot` 和可选 `partitionMode: single | call`。默认 single 写 `stage4-proof.txt`；call 模式把 Session ID 与 provider call ID 的哈希作为隔离目录名。两种模式都独占创建文件、使用 `0600`、遵循取消信号，并只返回安全相对路径和字节数。模型可见的名称、说明及参数 schema 没有在本次迁移中增加字段。

`@hands-on-dsh/cordis-plugin-lifecycle/listener` 根据 `rootSessionId`（或 `sessionMode: all`）、`toolName`、`auditPath`、`auditOwnerToken` 和可选 `healthPath` 工作。它先观察 live `tools/result` 的 call ID，再只接受对应 Session 的 durable `tool/result`。audit 留下 `live`、`durable` 两行；foreign、重复、mismatch 和 orphan 情况会被隔离或写入 health。owner sidecar 与 audit 文件使用 `0600`，重挂载要求相同 token。直接调用 `ctx.tools.execute()` 只有 live result；durable row 由 AgentLoop 提交。

两条 subpath 都是 named `name`、`inject`、`Config`、`apply` exports，没有 default export。其他项目以 tracked `file:`/workspace 依赖消费，不复制源码或依赖个人机器的绝对路径。

## 公开 preset probe

`pnpm test -t 'public preset declares'` 通过发布的 AgentPreset/Registry API 声明一个 `proof-only` preset，其 child list 包含本 package 的 `./tool`。测试读取 composition inventory、确认声明可解析，同时确认工具没有泄漏到 Host 的全局 `ctx.tools`。preset 声明 Agent 作用域中的插件组合；它本身不是安全沙箱，也不改变 runtime 的 host 文件权限。

## 真实模型与进程观察

根目录被忽略的 `.env` 可提供 `DEEPSEEK_API_KEY`；也可由调用方环境提供。下面的命令从本目录执行，先 build，再使用发布版同版本 resolver 拉起 `sdk-minimal`：

```sh
pnpm build
node --env-file=../../.env --import tsx examples/live-proof.ts --handshake-only
node --env-file=../../.env --import tsx examples/live-proof.ts
```

示例为每次运行创建独立 workspace、DSH_HOME 和 patch，禁用 profile 默认 persistent shell，只插入编译后的 proof tool/listener。它只把必要的路径与 DeepSeek 凭据传给子进程；不打印 key。prompt 要求精确内容与一次工具调用。它检查已完成 turn、唯一 root `tool/call` 和 `tool/result`、canonical 工具输出、外部 proof 文件的真实字节与 `0600`、live/durable audit call ID 及空 health，再在 SDK close 确认后删除临时状态。关闭失败时保留状态供排查。

2026-09-29 的真实发布包运行得到一次 `write_stage4_proof` 调用及一次 V4 durable 结果；audit 精确为 `live`、`durable` 且 call ID 相同。外部读取 proof 是 27 字节、`0600`，SHA-256 为 `3f119a4f8daeac10a4f80ecec504394590dc60ddeeda42008d888c1f68490a32`。独立 `ps` 采样捕获一个后代 PID，CLI 退出后该 PID 不再存在，stderr 为空。这是一次真实配置和模型请求的观察；模型回复本身不作为文件成功证据。

`sdk-minimal` 固定 `danger-full-access`；禁用默认 shell 只收窄模型可见工具，不限制 custom plugin 或 runtime 的 host 权限。proof workspace 是实验产物位置，不是安全隔离边界。需要隔离未知指令或多租户时应使用独立容器、Sandbox 和业务授权。

## 证据与范围

Keyless tests 覆盖 provider PENDING/ACTIVE/reactivation、effect cleanup、waterfall、HMR、tool schema 与 AgentLoop、proof 字节、V4 call ID、listener 的拒绝路径、preset 声明、teardown 和 packed consumer。源码事实来自固定 revision 的 [AgentLoop](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/agent-loop/README.md)、[工具结果类型](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/types.ts)与[preset registry](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/README.md)。旧版本的实验记录不自动证明新版行为；测试和上面的真实调用分别支持对应范围。
