# 2026-09-29 第四批：可恢复服务与 Session 格式迁移

接续 checkpoint `6bf3f63`。[设计](../superpowers/specs/2026-09-29-recovery-storage-design.md)与[计划](../superpowers/plans/2026-09-29-recovery-storage.md)固定范围：Python `0.1.5rc1` 的可恢复服务，以及 npm `0.1.7-rc.2` persistence library 的 V4 迁移实验。没有操作个人会话或生产数据库，没有修改 upstream。

## 可恢复服务

项目已从旧 session_root 启动迁移到公开 `sdk-minimal` / `dsh_home`；配置为 `RECOVERABLE_AGENT_DSH_HOME`，默认 `.dsh-recoverable-home` 被项目自己的 .gitignore 排除。新增正文事件是 root assistant_message 的完整文本，不伪装为 token delta。

SQLite schema 仍为 1。兼容测试重新打开旧格式数据库，确认原 `run_events(seq,type,data_json)` 行、解码后的 text_delta 事件、Artifact BLOB/SHA-256 和幂等提交都保持不变。恢复策略仍是将遗留 running 标为 execution_uncertain，要求确认后旋转 session；不自动重做旧任务，也不宣称 stock SDK 提供跨进程 resume。

从 `projects/recoverable-agent-service` 执行：

| 命令 | 结果 |
| --- | --- |
| `uv run --python 3.10 pytest` | 139 passed，1 个真实 E2E deselected |
| `uv run --python 3.10 ruff check .` | 通过 |
| `uv run --python 3.10 ruff format --check .` | 通过 |
| `uv lock --check` | 通过 |
| `uv run --env-file <本地凭据文件> pytest -m e2e` | 1 passed，真实发布 SDK/runtime |

本次 Python 下限环境为 3.10.20。完整 139 项回归之后，仅加强了旧数据库 raw data_json 行不变的测试断言；该 focused test 和 Ruff 再次通过，生产代码未变。

真实 E2E 使用独立临时 SQLite、workspace 和 Harness home：完整 FastAPI lifespan 创建 Conversation/Run，等待 succeeded/completed；下载产物必须精确等于无换行的 `RECOVERABLE_AGENT_SERVICE_E2E_PROOF_V1`（38 bytes），SHA-256 为 `8f0b99fb14fe8b40932d1446c3a4e944e0aacca7e6944c251f442ba8328f5ae4`。同键请求返回已有 Run，SSE 游标重连只返回后续事件并抵达 terminal；修改 workspace 原文件后，下载仍返回 SQLite 中的原始不可变 BLOB。外部 ps 观察到的 6 个后代 PID 在 lifespan 结束后全部退出。

此真实运行先于最后两处取消等待时的失败分类修复；正常完成路径未改变，分类修复由 gated keyless 回归验证。进程采样只证明本次观察到的 PID，未覆盖 Windows 或任意逃逸后代。

## Session V1 / V3 → V4 lab

新目录 `labs/session-format-migration` 精确锁定发布版 `dsh-session`、`dsh-session-persistence`、`dsh-session-persistence-jsonl` 为 `0.1.7-rc.2`，Cordis 为 `4.0.4`。这里只挂载存储 backend，使用公开 open/read/write API 和发布包的 worker；没有启动 Agent 或调用模型。

从 lab 目录执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，安装包含 migration worker |
| `pnpm test` | 7 passed，真实 backend/worker/文件系统 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm format:check` | 通过 |
| `node --import tsx examples/run.ts v1` | 非空 V1 历史 → 逻辑 V4，read 无发布，write 新增 V4 |
| `node --import tsx examples/run.ts v3` | 非空 V3 历史 → 逻辑 V4，read 无发布，write 新增 V4 |

两次 demo 也由协调者独立运行。Node 26.7.0、pnpm 12.3.4、macOS arm64 下观察到：

| 输入 | 迁移后的 assistant 文本 | stream 项数 | 源 SHA-256 前后 | write 后 generation |
| --- | --- | --- | --- | --- |
| synthetic V1 | `Synthetic V1 answer` | 4 | `46fb9f7c32a24cf9f5c51fa581375dde2879d74f21dddc03e306bb53221bcc64`，不变 | V1 + V4 |
| synthetic V3 | `Synthetic V3 answer` | 4 | `3f747f9ec2bbc50b0539268fbbb0a8d1952d2e92237d4525a080cbfb41b18a53`，不变 | V3 + V4 |

两个输入的 sourceBytesUnchanged、successorBytesStable、logicalReopenStable 均为 true。V1 的四条旧顶层 chunk 行被迁入 assistant message 的嵌入式 stream，结果不再有 assistant/chunk；这不是把 header 数字改成 4。关闭 backend 后重新挂载，逻辑历史与 successor 字节都稳定。

其他测试检查已有 V1+V3 predecessor 逐字节不变，以及 future generation、corrupt highest generation 和 unsupported historical body 均拒绝且不 fallback/不修改源文件。默认 Zstd 另行通过省略 compression 配置的新建 V4 header create/flush/open 测试；**历史迁移仅覆盖 plaintext synthetic V1/V3**，没有宣称覆盖压缩历史、附件、子会话 catalog 或真实用户复杂数据。

## 独立 review

两项服务 P2 已修复：

1. 取消 waiter 时，不能丢弃线程已返回的 `_SessionStartError`，否则会把明确未调用 Session.run 的失败错误分类为 execution_uncertain。现在保留已知线程失败的分类。
2. 原执行失败后的 cleanup 等待被取消，不能让原始 CancelledError 逃逸并中断持久 worker；需要先确认关闭，再保留 unavailable/uncertain 的原类别。

独立 reviewer 运行了 4 个 focused 取消/cleanup 回归与 lab 的 7 个测试，并核对旧数据库重放、产物和幂等约束。两个目录及共享对照没有剩余可操作问题。新 lab 的根目录外误生成过两个空 npm 文件，确认由本次工具操作产生后已移除，根仓库未引入工具链。

本批 62 个 Markdown 文件中的 209 个本地文件链接均存在（未检查远程 URL 或锚点）；服务与新 lab 的 2 个 Mermaid 图通过 parser，`git diff --check` 通过。

## 结论与后续范围

[对照说明](../comparisons/recovery-and-session-migration.md)区分业务恢复、ACP 会话恢复和格式迁移。当前完成的是可恢复服务 SDK 升级与最小格式机制实验；它不保证一次不确定工具副作用可以重试，也不表示旧客户端支持 V4 或降级。

接下来仍需迁移 Cordis/preset、AG-UI 和七篇核心机制笔记；更复杂历史数据与真正实时 token transport 保持独立待办。
