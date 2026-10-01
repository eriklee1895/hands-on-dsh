# 全章导航

这是一份按学习顺序组织的入口。版本以各章manifest/lockfile为准：Python课程使用 `0.1.5rc1`，DSH TypeScript、协议与机制实验使用 `0.1.7-rc.2`。Codex/Hermes章节另行记录实际CLI版本，不能把它们的能力或启动参数互相套用。

执行证据集中在[全章节验收索引](../reviews/2026-10-01-chapter-audit.md)。每章区分源码事实、keyless发布包运行、受控故障和真实模型；章节完成不表示其列出的所有生产限制都已消失。

## 1. Python集成

按[安装入口](../../tutorials/python-sdk/README.zh.md)准备uv与SDK，再依次完成：

1. [最小调用](../../tutorials/python-sdk/tutorials/01-hello.zh.md)
2. [复用runtime与Session](../../tutorials/python-sdk/tutorials/02-reuse-session.zh.md)
3. [通知与已提交消息](../../tutorials/python-sdk/tutorials/03-stream-events.zh.md)
4. [workspace工具任务](../../tutorials/python-sdk/tutorials/04-workspace-agent.zh.md)
5. [底层HarnessClient](../../tutorials/python-sdk/tutorials/05-low-level-client.zh.md)
6. [裸JSON-RPC](../../tutorials/python-sdk/tutorials/06-raw-jsonrpc.zh.md)

## 2. FastAPI与业务恢复

[FastAPI课程入口](../../tutorials/fastapi-101/README.md)包含可运行浏览器页面：

1. [同步API](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/01-blocking-api.md)
2. [SSE输出](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/02-sse-stream.md)
3. [多轮Session](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/03-multi-turn-session.md)
4. [工具轨迹](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/04-tool-trajectory.md)
5. [runtime生命周期](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/05-runtime-lifecycle.md)

随后完成[可恢复Agent服务](../../projects/recoverable-agent-service/README.md)：业务Run、SQLite、游标重放、不可变Artifact与execution_unknown。不要把业务恢复等同于底层会话resume。

## 3. 协议与TypeScript SDK

先做[SDK JSON-RPC/ACP实验](../../labs/protocol-semantics/README.md)，再按[TypeScript教程](../../tutorials/typescript-sdk/README.md)运行四个例子：

1. [显式profile启动](../../tutorials/typescript-sdk/examples/01_explicit_launch.ts)
2. [Session复用](../../tutorials/typescript-sdk/examples/02_reuse_session.ts)
3. [通知与root消息投影](../../tutorials/typescript-sdk/examples/03_notification_stream.ts)
4. [底层client](../../tutorials/typescript-sdk/examples/04_low_level_client.ts)

## 4. Plugin与完整应用

1. [Cordis/plugin生命周期](../../labs/cordis-plugin-lifecycle/README.md)：Service/inject、事件、effect、reload、tool/listener、preset与packed consumer。
2. [AG-UI/CopilotKit应用](../../projects/ag-ui-dsh-runtime/README.md)：业务状态、root投影、工具与Artifact、断线回放、跨generation恢复。

## 5. 七篇机制章

1. [Plugin tree与runtime组装](../../how-dsh-works/01-plugin-tree-and-runtime-assembly.md)
2. [Agent、Inbox与loop](../../how-dsh-works/02-agent-inbox-and-loop.md)
3. [Turn、Step与工具流水线](../../how-dsh-works/03-turn-step-tool-pipeline.md)
4. [Session事件日志与projection](../../how-dsh-works/04-session-event-log-and-projection.md)
5. [Context与compaction](../../how-dsh-works/05-compaction-and-context-assembly.md)
6. [Subagent与workflow](../../how-dsh-works/06-subagent-and-workflow.md)
7. [SDK、ACP与Web Host](../../how-dsh-works/07-sdk-jsonrpc-acp-and-web-host.md)

## 6. 机制实作与故障实验

| 主题 | 顺序 |
| --- | --- |
| Session存储 | [V1/V3→V4基础](../../labs/session-format-migration/README.md) → [压缩历史与发布版附件样本](../../labs/session-format-migration/RICH-HISTORY.md) |
| Compaction | [基础与真实pressure](../../labs/compaction-lifecycle/README.md) → [溢出/取消](../../labs/compaction-lifecycle/RECOVERY.md) → [prune/offload](../../labs/compaction-lifecycle/REDUCTION.md) → [真实服务端overflow](../../labs/compaction-lifecycle/PROVIDER-OVERFLOW.md) → [事务与并发](../../labs/compaction-lifecycle/TRANSACTIONS.md) |
| 附件 | [接纳/存储/真实视觉](../../labs/attachment-input/README.md) → [整请求fallback](../../labs/attachment-input/FALLBACK.md) → [预算与持久offload](../../labs/attachment-input/BUDGET.md) → [已删除Files ID恢复](../../labs/attachment-input/STALE.md) |
| Workflow/child | [基础PTC与冷恢复](../../labs/workflow-child-lifecycle/README.md) → [PTC崩溃、并行/重试、catalog与forest](../../labs/workflow-child-lifecycle/RECOVERY.md) |
| 官方Web | [实时帧/历史/重启](../../labs/web-host-lifecycle/README.md) → [审批/取消/离线](../../labs/web-host-lifecycle/CONTROLS.md) → [admission、重复投递、迟到回答与崩溃](../../labs/web-host-lifecycle/RECOVERY.md) |

## 7. 工程化七课

详细前置和验收规则见[工程化路线](engineering.md)。

1. [单runtime supervisor](../../labs/runtime-supervision/README.md)
2. [有界进程池](../../labs/runtime-supervision/POOL.md)
3. [认证与租户API](../../projects/recoverable-agent-service/TENANCY.md)
4. [本机文件策略](../../labs/sandbox-isolation/README.md)与[Linux容器/SSH执行](../../labs/sandbox-isolation/CONTAINERS.md)
5. [Run观测与教学用量估算](../../labs/run-observability/README.md)
6. [业务Eval与可重放回归](../../projects/recoverable-agent-service/EVAL.md)
7. [DSH双协议、Codex与Hermes适配](../../labs/protocol-semantics/ADAPTERS.md)

## 8. 六篇比较

- [Python与TypeScript SDK](../comparisons/python-vs-typescript-sdk.md)
- [SDK JSON-RPC与ACP](../comparisons/sdk-jsonrpc-vs-acp.md)
- [业务恢复、Session恢复与格式迁移](../comparisons/recovery-and-session-migration.md)
- [Session events与AG-UI](../comparisons/session-events-vs-ag-ui.md)
- [SSE与WebSocket](../comparisons/sse-vs-websocket.md)
- [DSH、Codex与Hermes](../comparisons/dsh-codex-hermes.md)

优先运行各章的keyless检查，再按章节条件使用自己的凭据完成真实任务。所有带故障、取消或crash的实验都要同时观察日志终态与外部文件；HTTP200、非空文本和进程退出都不能单独代替业务完成判断。
