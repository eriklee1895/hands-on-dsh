# 2026-08-31 历史机制 probes

这些结果仅对应 `dsh-v0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，不是新版验收。原记录在旧 revision 的独立 upstream checkout 执行，七篇涉及的 21 个 test files 合并回归为 **603/603 passed**；不是完整 upstream suite。本次迁移保留下面的当日命令与结果，未重新执行。段落中的“rc.2”“固定 revision”均指旧版。

## 01：Plugin tree 与 runtime 组装：从 profile 到可逆 lifecycle

在固定 revision 的 upstream checkout 根目录运行了一个不需要 API key 的 focused probe：

```sh
corepack pnpm exec vitest run \
  packages/boot/app-boot/tests/profile.spec.ts \
  -t "resolves each dsh.profile.bundles entry to its patch layer in order, plus the user layer"
# 1 test file passed; 1 test passed, 13 skipped
```

测试在临时目录中构造两个 fake bundle：第一层插入 entry，第二层覆盖它，profile 用户层再次覆盖。最终 entry 保留第一层给出的 plugin name，配置值来自最后一层。这个结果直接观察了 bundle 顺序与 user-layer precedence；它没有启动完整 base/web/headless composition，也没有覆盖 HMR 或进程信号。


## 02：Agent Inbox 与 AgentLoop：输入如何变成 turn、step 与 whole-agent idle

在固定 revision 的 upstream checkout 根目录运行了不需要 API key 的 focused probe；测试使用 `MockAdapter`：

```sh
corepack pnpm exec vitest run \
  packages/core/agent-loop/tests/loop.spec.ts \
  -t "runs a simple turn|starts idle steering synchronously|inject\\(\\) while idle"
# 1 test file passed; 3 tests passed, 51 skipped
```

三个通过的 case 分别观察到：ordinary input 先留下 inbox splice，再产生嵌套的 turn/step 事件并回到 idle；idle `steer()` 同步进入 running，后来的 steering 在下一 step 被消费；idle `inject()` 只留下 durable `next-step` splice，不打开 turn，直到后续 waking input 才进入模型请求。它们没有调用真实模型，也没有覆盖 cancellation、tool failure、resume 或多 caller 竞争。


## 03：Turn、Step 与工具执行流水线

在固定 rc.2 checkout 根目录实际运行了以下无 key probe：

```sh
env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL \
  corepack pnpm exec vitest run \
  packages/core/agent-loop/tests/loop.spec.ts \
  packages/core/agent-loop/tests/tool-calls.spec.ts \
  -t 'round-trips tool calls|commits tool/result in model order'
```

结果为 2 个 test files 通过，选中的 2 个 tests 通过，73 个未匹配 tests skipped，exit 0。第一个场景观察到模型请求工具、工具结果进入下一次模型请求；第二个场景让后一个 parallel 调用先 settle，durable `tool/result` 仍保持模型顺序。本 probe 使用本地 mock adapter 和 test tools，不调用真实模型。


## 04：Session Event Log、持久化与 Projection

在固定 rc.2 checkout 根目录实际运行了以下无 key probe：

```sh
env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL \
  corepack pnpm exec vitest run \
  packages/session/session-persistence-jsonl/tests/jsonl.spec.ts \
  packages/session/session-projection/tests/registry.spec.ts \
  -t 'lazy materialization|round-trip is byte-identical|rejects an unknown event type|drives a registered unit over committed events'
```

结果为 2 个 test files 通过，选中的 4 个 tests 通过，170 个未匹配 tests skipped，exit 0。实际覆盖了 compression `none` 下的 lazy materialization、包含 `assistant/chunk` 的 logical round-trip、unknown required event 拒绝与 unknown ignorable event 接受，以及 projection 对 committed events 的 eager fold 和 watermark snapshot。本 probe 没有启动 SDK subprocess 或真实模型。


## 05：Compaction 与 Context Assembly 如何共同形成下一次模型请求

在固定 rc.2 checkout 运行了以下 keyless focused probes：

```sh
corepack pnpm exec vitest run \
  packages/compaction/compaction-basic/tests/compaction-basic.spec.ts \
  -t 'lands a framed, replayable checkpoint with exact source seqs and token price'
# 1 file / 1 passed / 79 skipped

corepack pnpm exec vitest run \
  packages/core/agent-loop/tests/runtime-context.spec.ts \
  packages/core/system-prompt/tests/system-prompt.spec.ts
# 2 files / 44 tests passed
```

第一条 probe 实际落地了 bracket、summary、带 source seqs 的 replacement checkpoint 与 shadow price。第二组覆盖 assembly 排序/作用域/waterfall、context snapshot 去重/清除/恢复与 surface replacement 后的 projection 状态。它们没有发起真实模型压缩，也不是 compaction 全套测试。


## 06：Subagent 与 Workflow 如何分工

在固定 rc.2 checkout 运行了两组 keyless focused probes：

```sh
corepack pnpm exec vitest run \
  packages/subagent/subagent-fork-in-process/tests/subagent-fork-in-process.spec.ts \
  packages/subagent/subagent/tests/run-settlement.spec.ts
# 2 files / 20 tests passed

corepack pnpm exec vitest run \
  packages/workflow/workflow-worker-thread/tests/integration.spec.ts \
  packages/workflow/tool-workflow/tests/tool-workflow.spec.ts
# 2 files / 26 tests passed
```

第一组实际覆盖 fork seed/child composition/one-shot settlement-dispose 映射。第二组让真实 worker-thread engine 经结构化与普通 subagent 运行两阶段 workflow，并覆盖 model-facing tool 的 durable record、cancel、error、quiescent disposal 与 HMR cleanup。这里的 child LLM/provider 是确定性测试实现，没有消耗 API key。


## 07：SDK JSON-RPC、ACP 与 Web Host 不是同一层协议

在固定 rc.2 checkout 运行了三组 keyless focused probe：

```sh
corepack pnpm exec vitest run \
  packages/sdk/protocol/tests/transport.spec.ts \
  packages/sdk/server/tests/server.spec.ts \
  packages/sdk/client/tests/sdk-client.spec.ts
# 3 files / 75 tests passed

corepack pnpm exec vitest run \
  packages/acp/acp/tests/turns.spec.ts \
  packages/acp/acp/tests/approval.spec.ts \
  packages/acp/acp/tests/multi-session.spec.ts
# 3 files / 39 tests passed

corepack pnpm exec vitest run \
  packages/client/connection/tests/client-apply.client.spec.ts \
  packages/client/connection/tests/websocket-downlink.host.spec.ts \
  packages/host/apiproxy/tests/fetch-carrier.spec.ts
# 3 files / 56 tests passed
```

这些 probe 分别覆盖 JSONL correlation/server/high-level client、ACP turn/permission/multi-session，以及浏览器 WebSocket/downlink + ApiProxy fetch carrier；它们不是完整仓库测试。真实 SDK/ACP source prompt 记录见 [`labs/protocol-semantics`](../labs/protocol-semantics/README.md)。真实 Web 产品 Host 本篇没有启动；Stage 5 的 AG-UI 应用是自有 BFF，不是 DSH Web Host 的替代验证。
