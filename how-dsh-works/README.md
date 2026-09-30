# How DSH Works

本目录从可观察问题追踪 DSH 的生产方、事件、状态与读侧。七篇当前正文均按 **`dsh-v0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`** 审查，日期 2026-09-29。源码核对不等于所有执行链都已重新验收。

先完成 [Cordis lifecycle lab](../labs/cordis-plugin-lifecycle/README.md)，理解 Context、Service、inject、scope、effect 与 waterfall next，再按下表阅读。业务 Run/Task、DSH Agent、Session 与协议中的 prompt 各自拥有不同语义。

## 阅读顺序与证据范围

| 篇目 | 当前主要事实 | 当前运行证据 | 尚未验证 |
| --- | --- | --- | --- |
| [01 Plugin tree 与组装](01-plugin-tree-and-runtime-assembly.md) | profile 有序 patch；sdk-minimal 独立树；preset 修订与 scope | 已有新版 SDK profile initialize/close | preset 热更新、完整 HMR、平台矩阵 |
| [02 Agent Inbox 与 loop](02-agent-inbox-and-loop.md) | durable Inbox、Agent scope、initiator、write-handle resume | 新 probe：idle inject、followup 唤醒、whenIdle | maintenance/初始化/取消的全部竞争 |
| [03 Turn、Step 与工具](03-turn-step-tool-pipeline.md) | prepared admission、embedded stream、V4 tool message | 新 probe：未知工具 error → 下一 step；live/committed 输出 | parallel 顺序、retry、工具副作用与 repair |
| [04 Session 与 projection](04-session-event-log-and-projection.md) | V4 surface；read/write 迁移；不可变 generation；required projections | 已有 V1/V3 synthetic migration lab 7 项；新 probe 的内存日志 | 复杂真实历史、附件/catalog、压缩历史迁移 |
| [05 Context 与 compaction](05-compaction-and-context-assembly.md) | system 在 surface；request series；压缩 bracket | context snapshot probe；[compaction lab](../labs/compaction-lifecycle/README.md) 7项测试、真实pressure与持久重读 | overflow retry、取消中途提交、广泛摘要质量 |
| [06 Subagent 与 workflow](06-subagent-and-workflow.md) | parent catalog、continuable capacity、PTC 进程执行 | [PTC 与 child 冷恢复 Lab](../labs/workflow-child-lifecycle/README.md)：受控取消清理、真实产物及双进程恢复 | crash/森林恢复、复杂并行、外部 provider |
| [07 SDK、ACP 与 Web Host](07-sdk-jsonrpc-acp-and-web-host.md) | ACP control 与 generic tools；Remote mux；SDK 缺少 resume/cancel | 已有同版本 SDK/ACP 跨进程实跑；fake/keyless 协议测试 | 官方 Web Host、真实 cancel/permission |

这些限定直接对应每篇的 Verified from source、Observed at runtime、Inference/Proposal 和未确认部分；不以一条成功命令推断其他能力可用。

## 新版证据与重跑

本目录的 [published-core.test.mjs](probes/published-core.test.mjs) 是库级诊断测试，直接挂载发布的 Cordis/Agent/Session/Loop plugins；它不是另一种 DSH 应用 launcher。运行完整应用仍用公开 dsh profile。

该脚本只读解析 sibling `labs/runtime-supervision` 的精确锁文件安装，从 SDK 的同版本 dsh 和 sdk-minimal bundle 获取依赖，并逐包断言 DSH `0.1.7-rc.2` / Cordis `4.0.4`。不自动安装、不写 sibling 文件、不依赖 upstream master、不读取 key、不使用网络、文件工具或子进程。唯一模型 adapter 输出脚本内的确定性 fixture。若单独复制本目录而不安装 sibling lab，测试不可运行。

从仓库根目录准备并执行：

```sh
pnpm --dir labs/runtime-supervision install --frozen-lockfile
node --test how-dsh-works/probes/published-core.test.mjs
```

2026-09-29 在 macOS arm64、Node 26.7.0 上执行 `node --test` 完整探针，**3 tests passed**。第一次编写 probe 时两项断言因误读新版字段而失败；按固定源码将工具结果关联改为 `message.toolCallId`、展开 stream 改为读取 `{ time, chunk }` 后通过。这是探针校正，不是 DSH bug 修复。它没有运行上游完整测试，也没有真实模型结论。

同版本已有的独立证据由原目录持有，本次笔记编辑不重复模型调用：

- [runtime supervisor 执行记录](../docs/reviews/2026-09-28-execution.md)：公开 profile initialize/close 与一次 prompt，仅支持对应正常路径。
- [protocol 执行记录](../docs/reviews/2026-09-29-web-protocol-migration.md)：SDK receipt-to-idle、ACP close/list/第二进程 resume 与无工具 nonce 回忆；fake/keyless 与真实范围分开。
- [storage 执行记录](../docs/reviews/2026-09-29-recovery-storage.md)：synthetic V1/V3 到 V4、source hash、reopen 和拒绝路径；不证明 Agent 或业务任务恢复。

所有源码链接固定完整 revision。在任意 upstream checkout 中可只读核对，无须切换当前分支：

```sh
git rev-parse 'dsh-v0.1.7-rc.2^{commit}'
git describe --tags --always dsh-v0.1.7-rc.2
git show dsh-v0.1.7-rc.2:docs/architecture.md
```

预期分别为上述 SHA、`dsh-v0.1.7-rc.2` 与该版本架构。每篇另列实际入口或最小 git-show 命令；这是源码复核，不能伪称 runtime test。

## 历史结果

2026-08-31 的 `dsh-v0.1.1-rc.2` / `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` 曾运行七组 focused probes，并将 21 个 test files 合并验证为 **603/603 passed**。原命令、结果和局限保留在[历史 probes](historical-2026-08-31.md)。它们没有在新版重新执行，尤其旧 worker-thread 与 Web carrier 测试不能证明新版 PTC/Remote 行为。

## 内容归属

教程步骤放在 [tutorials](../tutorials/README.md)，完整业务作品放在 [projects](../projects/README.md)，单一机制实验放在 [labs](../labs/README.md)。本目录保存版本明确的机制说明和最小诊断 probes，不复制 upstream 实现。源码事实与运行观察允许未来版本推翻；业务正确性、生产安全与平台覆盖需要各自的验收。
