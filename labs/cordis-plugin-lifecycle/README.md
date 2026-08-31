# Cordis Plugin Lifecycle Lab

这是一个原创、keyless 的 DSH plugin 实验，不复制官方七章示例。领域主题是 proof journal：用一组可验证的 proof 记录来练习 Cordis service、inject、effect、typed event、waterfall、Loader/HMR，以及真实 DSH AgentLoop 的工具提交链路。

## 固定版本

- DSH：`0.1.1-rc.2`
- tag：`dsh-v0.1.1-rc.2`
- commit：`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`
- Cordis：`4.0.1`
- Node：`^22.19.0 || >=24.0.0`
- pnpm：`11.7.0`

官方教程只作为前置学习材料：

- [Cordis Tutorial](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-tutorial/)
- [Cordis Primer](https://deepseek-harness.github.io/deepseek-harness/reference/cordis-primer)
- [Plugin Development](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)

### 官方七章实跑记录（2026-08-31）

在固定 rc.2 upstream 的唯一 gitignored scratch 中，按官方中英文教程逐章使用 `node --import tsx ../../vendor/cordis/bin.js` 实际运行，没有 API key、网络或模型调用，也没有把官方示例复制进个人仓库：

1. `apply(ctx)` 成功输出，并验证 deliberate apply failure 以 exit 1 loud failure；恢复后再次成功。
2. child fiber 的 async effect disposer 只执行一次，重复 `dispose()` 幂等，并等待 cleanup 完成。
3. consumer 实际经历 `PENDING → ACTIVE → provider removed/PENDING → ACTIVE`，两次 activation 各有一次 cleanup。
4. `emit`、`parallel`、`serial`、`bail` 与 `waterfall` 均输出预期顺序；waterfall observer 调用 `next()`，独立 veto 明确短路 default。
5. schema default/显式 config 均成功；无效 config 在 `apply` effect 前以 exit 1 拒绝，marker 未创建。
6. stable-ID file/config HMR 均观察到旧 generation dispose 后一次新 apply，缺失 timer 的 consumer 报告可解释 PENDING；authoritative HMR 使用本机 Node 24.18，Node 24.6 watcher 未 reload 的 host observation 保留为版本边界。owned HMR process 最终回收。
7. 使用真实 `dsh-tools` registry 执行 keyless tool pipeline；live `tools/result` 在 execute promise 返回前到达，call ID/name/content 一致。

七章命令均 exit 0（章节 1/5 的 deliberate failure 分支按预期 exit 1）。结束后 upstream tracked/staged diff 仍为空，匹配章节进程为零；scratch 仅作为 ignored 学习证据保留。

## 架构

```text
ProofJournalService
  -> proof/recorded observer
  -> proof/authorize waterfall observer -> policy veto/default

Scripted LlmAdapter
  -> real AgentLoop
  -> write_stage4_proof
  -> live tools/result
  -> durable session tool/result
  -> correlated audit rows
```

`ProofJournalService` 是 `ctx.proofJournal` 的运行时提供方；TypeScript declaration merge 只补类型。consumer 使用 `inject: ['proofJournal']`，因此 provider 消失时会 cleanup 并回到 PENDING，provider 返回后只重新激活一次。

resource plugin 在一个 `ctx.effect()` 中拥有 timer、watcher 和 file descriptor。异步 disposer 依次停止资源并关闭 descriptor；外部 proof artifact 不会在 teardown 时删除。

## 可复用 DSH plugins

package build 后提供两个稳定 subpath：

- `@hands-on-dsh/cordis-plugin-lifecycle/tool`
- `@hands-on-dsh/cordis-plugin-lifecycle/listener`

二者都只有 named `name`、`inject`、`Config`、`apply` exports，没有 default export，可直接由 Loader 从 `cordis.yml` 解析。后续项目必须使用 tracked `file:`/workspace 依赖引用这些 subpath，不能复制源码或记录个人绝对 build path。

### `write_stage4_proof`

模型参数只有 `content`，没有 path 或 command。配置只提供 `workspaceRoot`；固定文件名是 `stage4-proof.txt`。插件使用 exclusive 默认调度、`open(..., 'wx', 0o600)` 和 cooperative cancellation。成功 canonical JSON 只有安全相对路径与 byte count；失败只清理由本次调用创建的 partial file。

Stage 5 兼容扩展增加 `partitionMode: single | call`，默认 `single` 保持上述行为。`call` 模式要求真实 Agent，把 `stage5-proof-v1\0<DSH session id>\0<provider call id>` 做 SHA-256，以 64 位 hex 目录隔离调用；返回路径和磁盘路径都不暴露 raw ID，模型仍不能选择路径。

### result/session listener

listener 先验证非空 session/tool、absolute audit path 和非空 `auditOwnerToken`。首次挂载以 `wx`/0600 相邻创建 audit 与 `.owner` sidecar；reload 只有在 owner token 匹配且两个文件均为 0600 regular file 时才能 append。listener 再从 matching root session 的首个 live `tools/result` 捕获 provider call ID，只接受相同 session/call ID 的 durable `session/event: tool/result`。foreign session、其他 tool、duplicate live、mismatched/duplicate durable row 都不会进入 audit。dispose 后同 owner token 可安全 remount 并记录下一对事件；直接调用 `ctx.tools.execute()` 只有 live result，durable row 必须经过 AgentLoop commit。

Stage 5 兼容扩展支持 `sessionMode: exact | all`。默认 exact 保持 `rootSessionId` 行为；all 模式不要求也不解释 rootSessionId。correlation slot 按 session 隔离，因此不同 session 可并发；同一 session 的 durable pair 完成后可以开始下一对，而 concurrent duplicate/mismatch 不会污染其他 slot。

## 运行

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm format:check
corepack pnpm build
corepack pnpm pack:smoke
```

HMR test 在项目 ignored `.runtime/` 中创建 copied probe 和 stable-ID `cordis.yml`，等待显式 readiness，再执行 file/config HMR，最后通过 TERM→KILL 有界阶梯回收准确 child PID。默认测试从 `STAGE4_HMR_NODE` 或使用平台 PATH delimiter/PATHEXT 扫描到的 Node executable 中收集 canonical 去重候选，并逐个真实尝试；不按版本号预判、不静默跳过。失败诊断会列出实际 executable version。本机默认父进程是 Node 24.6；首次 HMR 尝试失败，PATH 中的 Node 24.18 候选成功。

pack smoke 先 build/pack，再创建 fresh consumer。package 仅把 Cordis、DSH tools、DSH session 声明为 exact host peers，Schemastery 是唯一运行依赖；其他 AgentLoop/HMR closure 都是 dev dependencies。fresh consumer 显式提供完整 host peer closure，只通过 tarball subpath 和 plain Node Loader 运行，不依赖 tsx、源码路径或 tarball 内嵌的另一套 framework。smoke 还检查 tar entry allowlist，并外部读取 proof bytes。

## 已验证与未验证

Keyless tests 验证：PENDING/ACTIVE/reactivation、effect cleanup、waterfall next/veto、HMR、PENDING diagnosis、tool schema、scripted AgentLoop、exact artifact、live/durable call ID、listener rejection、teardown 和 packed Loader consumer。

2026-08-31 的 authoritative 真实模型 gate 在固定 rc.2 disposable upstream 的第二个唯一 gitignored composition 中执行；前一次结果保留为 preliminary。composition 从 minimal JSON-RPC 配置移除 persistent Bash/editor，只保留一个 model-visible `write_stage4_proof`：启动期 registry probe 在 prompt 前确认 visible tools 精确等于该名称。controller 在 `harness.start()` 前确认 proof、audit、owner sidecar 和独立 live-counter 全部不存在。

模型运行后，root `tool/call` 恰好 1 个，matching durable `tool/result` 恰好 1 个；其 `isError=false`，rendered canonical JSON 精确为 `{ "path": "stage4-proof.txt", "bytes": 27 }`。独立 observer 记录 matching live result 恰好 1 个，call ID、success state 和 rendered content 都与 durable row 相同；listener audit 仍精确为 `live`、`durable` 两行且 call ID 相同。外部验证得到 27 字节、0600、SHA-256 `678062f55ebaedf77ac923d146947003fd8caa0365aae5ee433fe921fc7a1d71`，最终 agent 到达 idle。正常退出后观察到的 runtime PID 消失，Stage 3 `.runtime` 无残留。

证据分层：固定 tag 源码证明 AgentLoop/tool/session 机制；本 lab keyless tests 证明个人 package 行为；上述一次真实模型运行只证明该次配置、provider 和 prompt。移除 Bash/editor 不等于 sandbox：custom plugin 和 runtime 仍有 host file/process authority。

## 清理

测试和 pack smoke 只删除自己在 `.runtime/<unique>` 中创建的目录。proof artifact 在 plugin teardown 时保留，由测试拥有者完成外部验证后再清理整个 unique test root。
