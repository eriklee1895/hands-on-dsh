# 2026-09-29 第三批：FastAPI 与协议实验

前两批已提交为 `124802b`，没有推送。本批按[设计](../superpowers/specs/2026-09-29-web-protocol-migration-design.md)和[计划](../superpowers/plans/2026-09-29-web-protocol-migration.md)继续迁移 FastAPI 101 与 protocol-semantics。

## 版本与交付范围

| 内容 | 固定版本 | 本批行为 |
| --- | --- | --- |
| FastAPI 101 | Python SDK/runtime `0.1.5rc1`，Session V3 | 公开 sdk-minimal/home；JSON 与 SSE；正文为已提交消息；模型失败与服务关闭明确表达 |
| Protocol semantics | npm DSH `0.1.7-rc.2`，Session V4，ACP SDK `1.4.0` | 项目自有 npm dsh CLI；SDK receipt-to-idle；ACP list/resume/close/config 与跨进程恢复 |

没有把命名为 chunk 的 ACP update 当作实时 provider delta，也没有给 SDK JSON-RPC 虚构 resume 方法。恢复服务、Cordis、AG-UI 和核心笔记仍维持旧版本；V4 历史日志的相邻迁移另行验证。

## FastAPI 检查

从 `tutorials/fastapi-101` 运行：

| 命令 | 结果 |
| --- | --- |
| `uv run pytest` | 27 passed |
| `uv run --isolated --python 3.10 --frozen --group dev pytest` | 27 passed，单独验证声明下限 |
| `uv run ruff check .` | 通过 |
| `uv run ruff format --check .` | 通过 |
| `uv lock --check` | 通过 |

真实 TestClient 场景使用发布 wheel、独立临时 home/workspace、`deepseek-official` / `deepseek-v4-flash`，未覆盖 base URL；实际 API 模式是此版本的 Chat Completions。

- JSON 回答包含 `FASTAPI_JSON_OK`，HTTP 200、completed。
- 同 session 两轮准确回读 `CERULEAN`。
- SSE 只有一条 root `assistant_message`，与唯一 `final.response` 一致，包含 `FASTAPI_SSE_OK`。
- 工具任务出现 1 次 call/result，Python 从磁盘核对 `b"alpha\nBETA\nend\n"`，精确 15 bytes。
- lifespan 结束后，本次外部 ps 观察到的 6 个后代 PID 均退出。

## 真实浏览器与页面错误

协调者在独立 `127.0.0.1:8157` 运行 Uvicorn，独立 browser session。命令从 FastAPI 子目录执行，环境中 `DSH_FASTAPI_HOME` 与 `DSH_FASTAPI_WORKSPACE` 指向本批 scratch 目录，凭据由 uv env-file 注入：

```sh
uv run --frozen --env-file <本地凭据文件> uvicorn dsh_fastapi_101.app:app --host 127.0.0.1 --port 8157
```

桌面第二章通过真实 POST SSE 得到 `WEB_COMMITTED_OK`；正文精确出现一份，事件序列含 assistant_message 和 final。375px 第四章通过真实工具任务得到 `BROWSER_TOOL_OK`，事件轨迹含两次 call/result；协调者从磁盘核对 `browser-proof.txt == b"BROWSER_TOOL_OK\n"`，16 bytes。两种视口未观察到页面水平溢出，浏览器未捕获非预期 JS errors。

错误 UI 单独通过 browser network route 注入 SSE error（没有调用模型）：显示 `Injected runtime failure`、错误终态、`role=alert`，运行按钮恢复可用。随后解除 route。

Axe 最初发现滚动时间线不可键盘访问；增加 focusable timeline 与预设 group 的语义后重新加载页面。对包含 40 条合成状态事件的滚动列表，375px 与 1280px 两次 Axe 4.12.1 均为 0 violations / 41 passes；仍有一类 contrast incomplete（渐变或遮挡背景），不能等同于完整可访问性认证。桌面及窄屏截图已人工查看。

关闭浏览器并直接对本次 Uvicorn PID 发送 SIGINT，日志确认 application shutdown complete；外部 250ms ps 采样观察到的 5 个后代 PID 全部消失。采样不能证明未观察到的短命或逃逸进程。浏览器真实 prompt 早于最后的 startup/shutdown cancellation 修复；正常 UI 行为未变，该修复由受控线程回归验证。

## Protocol 检查与真实恢复

本项目固定自己的 `@deepseek-ai/dsh` dependency，不借用其他教程 node_modules。真实模式命令从 `labs/protocol-semantics` 执行：

```sh
pnpm install --frozen-lockfile
uv sync --group dev
uv run --env-file <本地凭据文件> python -m protocol_labs.sdk_jsonrpc --server package
uv run --env-file <本地凭据文件> python -m protocol_labs.acp --server package
```

首次升级后，SDK 已通过实际发布 profile 的 initialize、非空 committed answer、matching receipt、root idle 和无信号升级的关闭。ACP 首次严格验收揭示旧 parser 不接受新版 `agent_message_chunk.messageId`；按固定 SDK 类型接收该字段后，真实 first prompt、关闭、inactive list、第二个 server 进程恢复与 exact nonce 回读全部通过。进程均 exit 0，没有 TERM/KILL escalation，owned group 消失。独立采样还记录 SDK 2、ACP 3 个后代 PID，CLI 退出后均不存在。

最终在 Python 3.10 执行 `uv run --python 3.10 pytest tests`，87 passed；`uv run --python 3.10 ruff check .`、`uv run --python 3.10 ruff format --check .`、`uv lock --check`、`pnpm install --frozen-lockfile` 和 diff 检查通过。

最后一次 ACP package 复测 exit 0、stderr 为空：listAfterClose=true、resumedSameSession=true、historicalUpdatesAfterResume=0、nonceRecalled=true，两轮 stopReason 均为 end_turn。两条 prompt 都明示不用工具，实际 first/second toolUpdates=0；排除了通过工具写读 workspace 文件来获得代号的路径。两次 close 均 returncode=0、groupGone=true、无信号升级，liveAcceptance=true。SDK 的成功实跑先于仅涉及故障状态保留的收尾修复，该修复用 keyless tests 验证，未重复调用模型。cancel/permission 的精确选择与 ID 双向相关性仍是 keyless 证据，不描述为真实模型取消或审批覆盖。

## Review

FastAPI 的独立 review 发现两种取消等待的竞争：取消 start awaiter 后 thread 仍可能创建 runtime；取消 close awaiter 会连带取消 tracked task，底层 thread 却未停。现通过保留并 shield 独立 startup/shutdown task，等待 owned work 结束后再关闭。3 个 gated regression 从 RED 到 GREEN，reviewer 复核通过。

协议 review 的两项问题也已修复：独立 OwnedState 记录每个 owner，closeOutcome 与独立进程组检查都确认退出后才清理；失败启动或未确认关闭时保留目录。历史重放检测覆盖当前 session 的 user/assistant/thought/tool 更新，排除合法配置通知与 foreign session。5 个 focused retention/replay 回归通过独立复核，随后全量 87 个 scoped tests 通过。能力对照已按固定 tag 核对：ACP 具备 list/resume/close/config，stock SDK 仍缺少对应控制方法。恢复模型上下文不意味着客户端收到旧 UI transcript。

本批 FastAPI/协议文档的 8 个 Mermaid 图通过 Mermaid 11.16.0 parser；最终遍历 57 个 Markdown 文件中的 195 个本地文件链接，均存在；不包括远程 URL 或锚点检查。`git diff --check` 通过。独立 review 没有剩余正确性问题。

## 后续

下一批处理 recoverable service、V4 历史数据迁移，再审查 Cordis/preset 和 AG-UI 的 transport/resume adapter。当前的同版本 ACP 恢复实验不代替旧 Session generation 升级验证。工程化其余单元继续按[路线](../learning-paths/engineering.md)推进。
