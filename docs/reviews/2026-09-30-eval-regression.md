# Phase 7.6：确定性评测与离线重评验收

2026-09-30 完成[可恢复服务 Eval 教程](../../projects/recoverable-agent-service/EVAL.md)。基线 `46bf702`；新增固定案例、独立实际观察、逐项评分、子进程超时保护和安全观测记录，不改变现有业务 API、SQLite schema 或 SDK 的取消/恢复能力。

项目继续锁定 Python SDK/runtime `0.1.5rc1`，运行环境为 macOS arm64、Python `3.10.20`。复用既有 FastAPI、TestClient、SQLite 和 uv 工具链，无依赖或 lockfile 变更。设计与执行项见[spec](../superpowers/specs/2026-09-30-eval-regression-design.md)、[plan](../superpowers/plans/2026-09-30-eval-regression.md)。

数据集 input/expected/metadata 的责任划分参考 [Langfuse 数据集指南](https://langfuse.com/academy/datasets)，案例期望取自现有服务约定和已有回归测试。本次未接入 Langfuse SDK、上传数据集或使用模型 judge；这不是开放题质量基准。

## 最终本地检查

项目目录 `projects/recoverable-agent-service` 中执行：

| 命令 | 结果 |
| --- | --- |
| `UV_NO_SYNC=1 uv run --offline --python 3.10 pytest` | 251 passed，原有真实 E2E 1 deselected |
| `UV_NO_SYNC=1 uv run --offline --python 3.10 ruff check .` | 通过 |
| `UV_NO_SYNC=1 uv run --offline --python 3.10 ruff format --check .` | 44 files 格式通过 |
| `uv lock --offline --check` | 36 packages，锁文件未变 |

既有 171 项回归通过，新增 80 项：contract/grader 35、scenario 18、record 3、CLI 4、process watchdog 20。`--no-sync` 使用已安装的锁定环境，避免本机共享 uv cache 锁影响执行，不绕过测试；CLI 在执行前还核对 SDK 与 runtime wheel 版本。

评分器严格检查 17 个字段，包括实际 runtime_finish；aborted 不能被同属 agent_outcome 的 max-tokens 替代。runner 的期望数据被故意设为不可读后仍能执行，证明它不从 expected 生成实际观察。下载字节、hash 和元数据分别核对；SSE 不仅比较 cursor suffix，还逐条对照 SQLite 持久事件。

文档检查：项目的3个Mermaid图通过Mermaid11.16.0解析，变更文档的63个本地文件链接均存在，`git diff --check`通过。

## 五个受控案例

最终 CLI 使用每例独立子进程，运行真实 SQLite/worker/HTTP/SSE/artifact 代码；适配器行为可控。结果为 selected 5、passed 5、failed 0、not_run 0。

| 案例 | Run / runtime finish | 关键观察 |
| --- | --- | --- |
| success | succeeded / completed | 产物 available，精确字节/hash，幂等与SSE通过 |
| tool-error | succeeded / completed | 1 个工具错误，产物 missing，下载404 |
| aborted-turn | failed / aborted | agent_outcome；不是一个新 cancel API |
| transport-disconnect | failed / null | execution_uncertain、attention_required |
| recovery | 新Run succeeded / completed | 旧running被恢复为执行不确定；无自动重跑，确认后新Session，旧Run及事件保留 |

`runtime_calls` 均为 1，表示 RuntimeAdapter.run 调用次数，不是底层 provider 请求数。各场景检查在生命周期 drain 后复核调用次数、finish 和持久 seq；同组残留进程会被回收并使评测失败。

终态后从完整 SSE 选择游标重放，覆盖的是持久事件的重连语义；使用 TestClient/ASGI，没有制造 TCP 断流。恢复是业务状态恢复与新 Session，不是 stock SDK 冷恢复。

## 负对照、重评与超时

- 正常记录并重载：`--record` 保存五例观察，`--replay` 的每项评分和 counts 与初次执行完全相同。重评不执行 runtime，报告 `execution=record-replay`。
- `--negative-control`：先实际运行，再把首例观测的 runtime_calls 加 1；退出码 1，passed 4、failed 1，失败项只有 runtime_calls。没有修改 fixture/expected 或录制变异观察。
- `--case success --case-timeout 0.001`：退出码 2，stdout 不包含通过 counts，stderr 给出保留目录，确认目录仍存在。这一人工短 deadline 验证 CLI 超时分类，不代表模型本身发生故障。
- watchdog 回归还真正挂起受控 adapter，让内部轮询超时后卡在 drain，再由外层 deadline 回收自有 group；独立 reviewer 确认原复现现在有界失败且 group 已不存在。
- 修改数据集 prompt 后仍传父进程此前的 digest：执行子进程拒绝，案例 root 尚未创建。记录与重评也拒绝不匹配的数据集指纹。

记录只保存有限标签、状态、计数、hash、大小和布尔观察；不含 prompt、响应、原始错误或凭据。文件为0600、拒绝覆盖、读取上限8MiB。指纹不是签名，不能阻止有写权限的人伪造观察；离线重评也不能代替对新代码重新执行场景。

## 真实模型与独立范围

真实 `success` 执行了两次独立实验，均成功：首次是原始同进程 runner，第二次验证新增的子进程 watchdog 路径。没有失败自动重试。两次均只有 success 被选择，其他四例明确 not_run。

第二次命令为 `uv run --offline --no-sync --python 3.10 --env-file <ignored .env> python examples/evaluate.py --real --record <new record path>`。真实 DSH 使用既有 adapter 的公开 sdk-minimal 启动，完成受控任务并由实际 HTTP 下载取得：

- 文件内容：`EVAL_SUCCESS_PROOF_V1`，21 bytes，无尾随换行。
- SHA-256：`f85063b8ebbe7bb5ff2d7f3ceb6ddaaf8006a3217a9d156c67856540dd7a86ed`。
- Run succeeded，runtime_finish=completed，artifact available / HTTP200，元数据匹配。
- runtime_calls=1，tool_errors=0，幂等重放、SSE精确重放、cleanup确认全部通过。
- 保存后离线重评：mode仍为real-provider，execution为record-replay，selected1/passed1/not_run4。

外部每200ms采样，第二次累计观察到6个后代PID，峰值同时5个；PID为`67455,67456,67461,67624,67716,67734`，退出后全部不存在，命令退出0。首次采样5个PID也均退出。采样不覆盖任意脱离父子树或process group的进程；watchdog亦不撤销远端副作用。

第二次真实调用之后仅新增执行前父子数据集 digest 核对；同一未修改的数据集没有重新调用模型。最终 digest guard 用完整五例受控执行、数据集突变拒绝和真实记录离线重评验证。真实工具错误、用户取消、网络断线和 SDK 冷恢复没有在本课注入，不用成功用例替它们背书。

原始本机证据位于被忽略的 `.superpowers/sdd/2026-09-30-eval-regression/`：`digest-guard-report.json`、`final-controlled-observations.json`、`final-negative-report.json`、`timeout-evidence.json`、`final-real-observations.json`、`real-run.log`、`real-replayed-report.json`、`processes.json`。首次真实记录单独保留为 initial 前缀。

## Review 与后续

独立 review 的三个P2均已修复：轮询超时仍卡在drain、drain期间迟到工作漏计、父子进程执行不同数据集版本却归到同一记录。新增回归先失败后通过，reviewer分别重跑原复现；最后42项focused检查通过，无待修项。另加CLI文件清理失败回归，保证基础设施失败不先输出通过报告。

7.6完成的是确定性应用约定评测。未提供生产质量统计、judge校准、远端CI部署或防篡改审计。下一课为[7.7跨runtime适配](../learning-paths/engineering.md)；7.4容器/远程执行集成仍待扩展。
