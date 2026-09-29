# 2026-09-28：DSH 上游变化与教程迁移审查

## 结论

旧课程完成状态只适用于当时的版本。新 TypeScript 内容选择已发布 `0.1.7-rc.2`，旧 Python 课程按 `0.1.1rc1` lockfile 保持可复现，Python 升级单独以可获得的 wheel 为准。启动接口、流式事件、持久化和模型适配器都已变化，不能全局替换版本号后沿用 8 月验收结论。

审查日期为 2026-09-28；以下源码结论来自固定 tag，发布状态来自当日 GitHub/npm/PyPI 查询。新代码和实际运行结果见[执行记录](2026-09-28-execution.md)。

## 版本真源

| 对象 | 本次核验结果 | 依据 |
| --- | --- | --- |
| 旧 Python SDK/runtime | 三个 Python 项目 lockfile 均为 `0.1.1rc1`，不是 rc.2 | `tutorials/python-sdk/uv.lock`、`tutorials/fastapi-101/uv.lock`、`projects/recoverable-agent-service/uv.lock` |
| 旧 TypeScript、protocol source lab、源码笔记 | `0.1.1-rc.2`，`b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` | 各项目 manifest、`labs/protocol-semantics/versions.json` |
| GitHub 最新发布 | `dsh-v0.1.7-rc.2`，2026-09-24，仍为 prerelease | [Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2) |
| 新版固定 revision | `477b4f420553e8a52c2fbccc464d7561b239c443` | tag 与 `git ls-remote` 一致 |
| npm SDK/protocol | `next=0.1.7-rc.2`；`latest=0.0.1-rc.1` | [SDK registry](https://registry.npmjs.org/@deepseek-ai%2fdsh-sdk-client)、[protocol registry](https://registry.npmjs.org/@deepseek-ai%2fdsh-sdk-protocol)；必须显式 pin，不能依赖 latest |
| PyPI SDK/runtime | 最新均为 `0.1.5rc1`；没有 `0.1.7rc2` | [SDK metadata](https://pypi.org/pypi/deepseek-harness-sdk/json)、[runtime metadata](https://pypi.org/pypi/deepseek-harness-runtime-bin/json) |
| 上游 master 观察点 | `21638c56315ae6a2b552d6091945d3144c9af32e`，领先发布 tag 155 个可达 commits | `git ls-remote origin refs/heads/master`、`git rev-list --count <tag>..master`；包含分支提交，不表示 155 项功能 |

旧 rc.2 到新 rc.2 有 6875 个可达 commits。此次是面向课程依赖的定向 review，覆盖以下接口，不是逐 commit 的全仓库审计。

## 1. 启动已统一到 dsh profile

TypeScript SDK 不再接受公开 `launch.command/args`。新接口是 `profile`、`patches`、`dshHome`、`processCwd`、可选 `dshBin`；默认解析同版本 `@deepseek-ai/dsh`，由 Node 执行 `dsh --profile sdk`。这让“TypeScript 必须手工指定 runtime 命令”的旧比较失效，但并不意味着它携带 Python 式平台单文件 runtime。

Python 新源码也使用 `profile`、`patches`、`dsh_home`，旧 `session_root`/直接完整 Cordis 配置不能照搬。Python 发行 wheel 的可用版本必须另查。

依据：[架构](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/architecture.md#application-launch)、[TS launch](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/launch.ts)、[公开选项](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/types.ts)、[Python API](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/python/sdk/src/deepseek_harness/api.py)。

受影响：`tutorials/typescript-sdk/src/runtime-launch.ts`、`labs/protocol-semantics/src/protocol_labs/launch.py`、`projects/ag-ui-dsh-runtime/src/server/source-runtime.ts`、Python 六个脚本及服务的 runtime 配置。升级验收必须覆盖 cold home、foreign cwd、失败初始化、正常关闭；不使用旧 SDK package bin。

## 2. 实时流与持久记录分开了

旧 `assistant/chunk` 已从当前 session event vocabulary 移除。进程内实时呈现使用 `agent/assistant-stream`；持久化的 `assistant/message.stream` 与 `assistant/attempt.stream` 保存紧凑的带时序记录。不能把一次提交后展开的 stream 伪装成实时 token 推送。

固定 rc.2 的 SDK server 订阅 `session/event`、status 和 subagent 生命周期，未订阅 `agent/assistant-stream`。因此旧代码过滤 `session.event` 内 `assistant/chunk` 会得不到原来的增量输出；完成后的 `finalResponse` 与通知流仍可用。这是源码判断，尚不是新版真实逐 token E2E。

依据：[流式机制](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/subsystems/llm-streaming.md#compact-assistant-streams)、[SessionEventMap](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/types.ts)、[server 订阅](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/server/src/server.ts)。

受影响：Python `03_stream_events.py`、`05_low_level_client.py`、`06_raw_jsonrpc.py`、FastAPI 事件投影、TypeScript notification projection、AG-UI projector、协议 fixtures。迁移课需明确选择 committed message 输出或受支持的实时 transport，再验证首 token 时序、最终文本和断线 replay；不能只改 fixture 让测试过。

## 3. Session writer 已到 V4

tag 中 `SESSION_FORMAT_VERSION = 4`，而同 tag 的 release-status 文档仍记录 `latestReleasedVersion: 3`。GitHub 已发布该 tag，所以不能据旧 release-status 文档说 V4 未发布。这是此次发现的上游文档记录滞后，不修改 upstream。

相邻迁移、旧 generation 保留、V4 message/tool 内容和投影读取都影响课程。升级实验先用旧版本制造日志，再用新版本打开副本，检查 successor 和 replay；不得直接覆盖读者已有 session。新格式能迁移旧数据不等于旧 runtime 能读取新格式。

依据：[tag writer](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/core/session/src/types.ts)、[tag release-status](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/session-format-status.md)、[相邻迁移规则](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/.agents/notes/implemented/architecture/2026-08-31-released-session-format-migrations.md)。

## 4. 模型适配器改为 Messages

官方 DeepSeek transport 使用 Messages/Files，默认 root 为 `https://api.deepseek.com/anthropic`。API-key 与 account provider 分开，不能把旧 OpenAI-compatible base URL 直接传给新官方 adapter。SDK 的 initialize 增加 `reasoningEffort`，prompt 支持编码图片并由 runtime admission 写入附件。

依据：[DeepSeek adapter](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/README.md)、[SDK protocol](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/protocol/src/types.ts)。

受影响：所有 `.env.example`、模型配置说明、真实 E2E 与 fixtures。真实测试必须分别核对 endpoint、模型和路由；单元测试成功不说明现有代理支持 Messages。

## 5. SDK 恢复、cancel 与业务状态

新 wire 方法仍为 `initialize`、`session/prompt`、`shutdown`。`createSession()` 仍调用 `ctx.agents.create()`，没有公开 resume/cancel RPC。原 AG-UI 的 generation-local resume adapter 不能因为上游更新就删除；也不能直接保留旧 monkey-patch 而不复核新 profile、preset 和 migration。

`run()` 仍从 durable Inbox receipt 收集到 whole-agent idle。Promise resolve 不等于模型成功，`turn/end` 中可能有 error/max-tokens 等结果。supervisor 只管理执行资源，Conversation/Run/Artifact 仍由业务应用持有。

依据：[SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/server/src/server.ts)、[高层 run](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/api.ts)。

## 6. Plugin/preset 与发布后观察

Agent composition 已由 profile YAML 中的 preset rows 声明，plugin manager 加强 peer compatibility；旧 Cordis 实验要检查 vendor 版本、包依赖和 composition，而不仅是 apply/inject。注册仍需要归属 effect/disposer。

依据：[Preset registry](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/README.md)、[peer compatibility PR](https://github.com/deepseek-ai/deepseek-harness/pull/4980)。

发布后的 master 还出现 session-log OpenTelemetry（PR #5216）、工具失败历史修复（#4595）、Git 环境清理（#5265）等合并。它们只是后续专题的观察项；不描述为 `0.1.7-rc.2` 已包含，也不据标题推断完整行为。

## 迁移顺序

| 批次 | 产物 | 完成条件 |
| --- | --- | --- |
| A，本次 | 此审查、版本提示、工程化路线、单 runtime supervisor lab | 新版 SDK 类型检查、故障测试与真实 profile handshake 分开记录 |
| B | Python/TS SDK 教程更新及 SDK 比较重写 | 对应发布包 frozen install；所有示例重新执行；runtime 回收外部验证 |
| C | 协议/stream/V4 lab、FastAPI 与 recoverable service | 旧日志迁移副本、明确实时/提交输出、恢复与幂等验收 |
| D | Cordis/preset、AG-UI 项目与 7 篇源码笔记 | profile plugin 安装、跨 generation 记忆、UI/replay 与 fixed-revision probes |
| E | 工程化其余专题 | 按[工程化路线](../learning-paths/engineering.md)逐课独立验收 |

不以阶段数量百分比估算剩余工作：C/D 的 transport 与恢复选择需要实验结果后才能定实现量。

## 2026-09-29 补充：ACP 持久会话控制

后续定向审查发现 `0.1.7-rc.2` 的 ACP 已使用 SDK `1.4.0`，支持 `session/list`、`session/resume`、`session/close` 与 `session/set_config_option`；这不改变上文关于 SDK JSON-RPC 缺少 resume RPC 的结论。list 只返回 inactive 可恢复 root；resume 校验 cwd 且不回放旧 updates。固定源码与最新对照见[协议选型](../comparisons/sdk-jsonrpc-vs-acp.md)，实际 probe 范围见[第三批记录](2026-09-29-web-protocol-migration.md)。
