# 从现象读懂 DSH

跑过 SDK 和插件实验后，你已经见过输入、工具和回复。这七篇继续追问：输入记进日志后为什么还没运行，工具返回以后为什么还要一次模型请求，重启后怎样区分历史、活跃 Agent 和业务任务。

所有机制解释固定在 `dsh-v0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`。先读 [Cordis 生命周期实验](../labs/cordis-plugin-lifecycle/README.md)，理解依赖激活与 effect 清理，再按下面的顺序追踪。正文中的源码事实、实验观察和由此推导的应用建议各自标明范围。

## 带着问题阅读

| 顺序 | 这一章要解释什么 | 对应实验 |
| --- | --- | --- |
| [01 Plugin tree 与组装](01-plugin-tree-and-runtime-assembly.md) | 配置中有工具，为什么某个 Agent 看不见？ | profile 启动、Cordis lifecycle/preset |
| [02 Agent Inbox 与 loop](02-agent-inbox-and-loop.md) | 输入已经入队，为什么仍然 idle？ | inject/followup 探针、[维护并发](../labs/compaction-lifecycle/TRANSACTIONS.md) |
| [03 Turn、Step 与工具](03-turn-step-tool-pipeline.md) | 工具失败后，模型还能怎样继续？ | 未注册工具探针、受控并行与 retry |
| [04 Session 与 projection](04-session-event-log-and-projection.md) | 旧消息还在日志中，为什么不再进入模型？ | [格式迁移](../labs/session-format-migration/README.md)、[复杂历史](../labs/session-format-migration/RICH-HISTORY.md) |
| [05 Context 与 compaction](05-compaction-and-context-assembly.md) | 压缩怎样改变下一次请求，失败时又留下什么？ | [compaction 系列](../labs/compaction-lifecycle/README.md)、[附件系列](../labs/attachment-input/README.md) |
| [06 Subagent 与 workflow](06-subagent-and-workflow.md) | 父子关系如何持久化，哪些 child 能继续对话？ | [基础 PTC/child](../labs/workflow-child-lifecycle/README.md)、[恢复实验](../labs/workflow-child-lifecycle/RECOVERY.md) |
| [07 SDK、ACP 与 Web Host](07-sdk-jsonrpc-acp-and-web-host.md) | 同一 runtime 经不同入口能提供哪些控制和输出？ | [协议](../labs/protocol-semantics/README.md)、[官方 Web](../labs/web-host-lifecycle/README.md) |

先把每章的一个现象解释清楚，再展开源码表。生命周期和故障往往比函数名称更值得记：谁接纳了输入、谁能取消工作、哪个事件已经提交、谁最终释放资源。

## 新版证据与重跑

[published-core.test.mjs](probes/published-core.test.mjs)提供三项无 Key 库级探针：输入唤醒、工具失败进入后续请求、runtime context 快照。它挂载真实发布的 Cordis/Agent/Session/Loop plugins，模型 adapter 输出确定性 fixture；不联网、不执行文件工具，也不启动 DSH 子进程。完整应用仍通过公开 profile 启动。

从仓库根目录准备并执行：

```sh
pnpm --dir labs/runtime-supervision install --frozen-lockfile
node --test how-dsh-works/probes/published-core.test.mjs
```

探针从 sibling Lab 的安装只读解析依赖，逐包断言 DSH `0.1.7-rc.2` 和 Cordis `4.0.4`；不会自动安装或写 sibling 文件。只复制本目录而没有上述依赖时不能运行。2026-09-29 在 macOS arm64、Node 26.7.0 的记录为 3/3 passed；那次编写时曾修正 toolCallId 和 embedded stream 的字段断言，不构成 upstream bug。

真实模型、磁盘持久化、浏览器及容器由对应 Lab 分别验证。各项命令和结果集中在[全章验收索引](../docs/reviews/2026-10-01-chapter-audit.md)，保留自己的运行日期。任意执行中崩溃、全部取消交错、生产隔离与一般摘要质量等，仍按各章明确范围判断。

## 对照固定源码

在具有该 tag 的 upstream checkout 中可只读核对，无须切换当前分支：

```sh
git rev-parse 'dsh-v0.1.7-rc.2^{commit}'
git describe --tags --always dsh-v0.1.7-rc.2
git show dsh-v0.1.7-rc.2:docs/architecture.md
```

前两项应得到页首 SHA 和 tag；第三项打开这一版的架构说明。各章再列具体生产入口。这些命令检查源码，不代表 runtime 已经运行过那条路径。

## 历史与内容归属

[2026-08-31 历史 probes](historical-2026-08-31.md)保留旧 `0.1.1-rc.2` 的 21 个文件、603 项 focused tests。旧 worker-thread、Web carrier 和事件字段不能直接解释当前版本。

需要可运行步骤时去 [tutorials](../tutorials/README.md) 或 [labs](../labs/README.md)，需要端到端业务作品时去 [projects](../projects/README.md)。这里负责解释机制及其固定源码，不复制完整实现。
