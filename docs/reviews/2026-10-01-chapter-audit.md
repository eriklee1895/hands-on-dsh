# 全章节验收索引（进行中）

本次目标为完成既有Phase 1–7全部chapter。基线77f3fdd，当前各章固定版本保持不变；执行计划见[全章节计划](../superpowers/plans/2026-10-01-complete-chapters.md)。此页进行中，不替代已有逐批验收，也不把“未验证”改写为成功。

| 课程组 | 现有入口 | 已有证据 | 本批动作 |
| --- | --- | --- | --- |
| Python SDK 6章 | [中文课程](../../tutorials/python-sdk/README.zh.md) | [SDK迁移](2026-09-28-sdk-migration.md) | 完成目录/命令审计 |
| FastAPI 5章 | [课程](../../tutorials/fastapi-101/README.md) | [协议/Web迁移](2026-09-29-web-protocol-migration.md) | 完成目录/命令审计 |
| TypeScript SDK 4例 | [课程](../../tutorials/typescript-sdk/README.md) | [SDK迁移](2026-09-28-sdk-migration.md) | 完成目录/命令审计 |
| 协议与7.7 | [协议](../../labs/protocol-semantics/README.md) | [DSH双协议基础](2026-09-30-runtime-adapters.md) | 补跨引擎 |
| Cordis/plugin | [生命周期](../../labs/cordis-plugin-lifecycle/README.md) | [plugin/AG-UI](2026-09-29-plugin-agui-internals.md) | 完成章节覆盖审计 |
| 可恢复服务与AG-UI | [业务服务](../../projects/recoverable-agent-service/README.md)、[AG-UI](../../projects/ag-ui-dsh-runtime/README.md) | 迁移、租户、eval、跨generation记录 | 保留证据、修正导航 |
| 机制7章 | [索引](../../how-dsh-works/README.md) | 固定源码、compaction/workflow/Web/附件各Lab | 补剩余恢复/存储/控制案例 |
| 7.1–7.6 | [工程化](../learning-paths/engineering.md) | supervisor/pool/tenant/sandbox/observability/eval | 补容器与远程执行 |

审计发现并修正：主README“最新第五批”、Phase7“从第一课开始”和TypeScript路线“compaction/workflow/Web未重跑”已落后于已提交结果，将随最终目录核对一起修正。Docker daemon为本机OrbStack Linux arm64，可进行自有容器实验；Codex/Hermes入口已安装，尚未把可执行文件存在当成真实模型验收。

复杂历史子集完成：[压缩迁移/发布版存储样本](2026-10-01-rich-history.md)，16项测试；独立review的完整内容断言及真实V5头两处P2已修正。Task3仍等待child catalog/forest，不按子集宣布全项完成。

容器/远程执行基础完成：[7.4补充验收](2026-10-01-container-executor.md)，3项真实Docker/SSH/provider测试，另有11项本地测试（默认跳过Docker）。两处review P2已修正并复核；不扩大为网络隔离、bwrap验证或完整多租户安全。

图片/服务端错误链路完成：预算2672c91、已删除Files恢复e2523d9，以及[实际服务端overflow](2026-10-02-provider-overflow.md)。前两者与服务端错误分别记账，未把本地预算改名为服务端quota。

两篇比较章节完成：[Session events与AG-UI](../comparisons/session-events-vs-ag-ui.md)、[SSE与WebSocket](../comparisons/sse-vs-websocket.md)，复用明确日期的项目/Web运行证据并核对当前代码；独立review修正Host发送ready与Client发布connected的职责表述。实时transport清单以官方Web证据核销，不改变stock SDK/ACP能力。跨引擎比较仍等待Hermes实跑与整体复核。

跨引擎与第三篇比较完成：[Codex/Hermes验收](2026-10-02-cross-engine.md)，133项本地测试，双方均有真实文件字节和新严格nonce通过。Hermes两次早期结果不明保留，未重放旧任务；三处review P2修复后再次独立复核通过。能力表继续区分not-integrated与产品能力。

复杂历史与workflow恢复集成完成：[PTC/forest/catalog验收](2026-10-02-workflow-recovery.md)，18项测试含真实PTC kill与第二进程正常/flush后SIGKILL恢复。它与存储16项合起来关闭Task3；半写入frame和任意执行中断仍是明确限制。两处review P2已修正并复核。

Compaction事务/并发完成：[四场景验收](2026-10-02-compaction-transactions.md)，36项Lab测试、4个独立profile、全部事件重读；flush-after还在抛错前读回checkpoint。与workflow恢复一起关闭Task4，保留真实物理I/O与任意并发篡改限制。
