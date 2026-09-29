# 2026-09-28 第二批：SDK 教程迁移

接续[第一批](2026-09-28-execution.md)，在同一 worktree 更新两套 SDK 入门。[设计](../superpowers/specs/2026-09-28-sdk-migration-design.md)与[执行计划](../superpowers/plans/2026-09-28-sdk-migration.md)明确范围。

## 固定版本与交付

| 教程 | 发布版本 | 源码 commit | Session writer | 官方模型传输 |
| --- | --- | --- | --- | --- |
| [Python 六例](../../tutorials/python-sdk/README.zh.md) | `0.1.5rc1` | `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` | V3 | Chat Completions |
| [TypeScript 四例](../../tutorials/typescript-sdk/README.md) | `0.1.7-rc.2` | `477b4f420553e8a52c2fbccc464d7561b239c443` | V4 | Messages |

两套教程已采用公开 profile/home/patch，精确锁定发行包并更新章节和测试。第三例明确演示 root committed-message 投影，不再宣称 `assistant/chunk` 实时 token 输出；同进程 session 复用与跨进程 resume 分开说明。Python 六篇中英文章和 TS README 均更新，选型对照与学习路线同步。

FastAPI、protocol labs、Cordis、AG-UI 和核心笔记仍保持各自旧版本，不包含在本批升级中。未修改 upstream、未 stage/commit/push。

## Keyless 与工具检查

命令分别从 `tutorials/python-sdk` 和 `tutorials/typescript-sdk` 执行。macOS arm64；Python 主环境 `3.14.0`，Node `26.7.0`，pnpm `12.3.4`。

| 目录 | 命令 | 结果 |
| --- | --- | --- |
| Python | `uv sync --group dev` | 安装 SDK/runtime `0.1.5rc1`；后续 frozen 环境读取确认版本一致 |
| Python | `uv run pytest` | 19 passed |
| Python | `uv run --isolated --python 3.10 --frozen --group dev pytest` | 19 passed，另行验证声明的 Python 下限 |
| Python | `uv run ruff check .` | 通过 |
| Python | `uv run ruff format --check .` | 通过 |
| TypeScript | `pnpm install --frozen-lockfile` | 通过 |
| TypeScript | `pnpm test` | 30 passed（nonce review 修复后） |
| TypeScript | `pnpm typecheck` | 通过 |
| TypeScript | `pnpm lint` | 通过 |
| TypeScript | `pnpm format:check` | 通过 |

新增/调整的行为回归覆盖：公开 profile 启动、root 与 child/foreign 区分、receipt-before-response、EOF、活动总时限、超时前已排队通知、非有限 CLI 时限、失败模型终态、exact nonce、工具字节、失败关闭后保留目录。旧 source-checkout attestation 测试随已删除的私有启动实现移除，不把原来的测试数量当作新版门槛。

## 真实模型与进程观察

Python 在教程目录执行 `uv run --env-file <本地凭据文件> python <脚本>`，使用 `deepseek-official` / `deepseek-v4-flash`，未设置 base URL 覆盖；最终六例都 exit 0。每例独立创建路径，脚本外部通过 `ps` 遍历父子关系并在退出后检查 PID。

| Python 示例 | 结果 | 观察到的后代 / 退出后存活 |
| --- | --- | --- |
| 01 | `hello from dsh`，completed | 2 / 0 |
| 02 | `stored` 后准确回读 `SAFFRON`，completed | 2 / 0 |
| 03 | root 已提交消息与最终回复一致，completed | 2 / 0 |
| 04 | 工具输出精确等于 `b"blue\ngreen\nred\n"`，completed | 2 / 0 |
| 05 | `low level client ok`，对应 receipt 后结束 | 2 / 0 |
| 06 | `raw json rpc ok`，原始 JSON-RPC 正常关闭 | 2 / 0 |

TypeScript 在教程目录通过 `node --env-file=<本地凭据文件> --import tsx examples/<脚本>` 执行四例，使用 `deepseek-official` / `deepseek-flash`，全部 exit 0，stderr 为空。正常退出后 `.runtime` 没有剩余示例目录。

| TypeScript 示例 | 结果 | 观察到的后代 / 退出后存活 |
| --- | --- | --- |
| 01 | `TypeScript SDK 已连接。` | 2 / 0 |
| 02 | 同一 session 回读 `amber` | 2 / 0 |
| 03 | 1 次 tool call/result；34 字节 proof 精确匹配 | 12 / 0 |
| 04 | initialize identity、matching receipt 和最终文本 | 2 / 0 |

模型措辞不是稳定 fixture。工具字节比较与进程观察独立于模型回答；PID 采样不能证明未观察到的短命或逃逸后代，也不覆盖 Windows/Linux。TypeScript 的四次真实运行先于最后的 `--nonce` 精确校验修复；默认 `amber` 不变，修复使用 keyless 回归验证，未重复调用模型。

## Review 与问题修复

独立 reviewer 核对固定 tag 的 SDK/server、生命周期与共享版本说明。两项 P2 已修复：

1. TypeScript 原来用 substring 检查 `amber`，`chamber` 也会误过；自定义 prompt 还可能与硬编码代号冲突。现在 `--nonce` 默认 `amber`，默认 prompt 使用所选代号，回答按 trim + NFKC 做精确匹配。回归覆盖错误 substring 和自定义 SAFFRON。
2. Python raw client 的文本按 receipt 到首次 root idle 限定，但 scalar finish reason 曾可能被迟到 response 之前的后续 turn 覆盖。现在终态也保存序号并限制在同一区间；回归同时覆盖后续 success 不能遮盖本次 error，以及后续 error 不能破坏本次 completed。

协调 review 还发现 `queue.get(timeout=0)` 会继续取出过期但已排队的通知；现在 dequeue 前先检查绝对 deadline，并拒绝 NaN/Infinity。关闭失败保留临时 home，模型 error/max-tokens 不作为成功退出。独立 reviewer 对修复分别运行了 7 个 Python 和 3 个 TS focused tests，无剩余正确性问题。

本批另行校验 Python 章节的 12 个 Mermaid 图，使用 Mermaid `11.16.0` parser 均通过。最终遍历 54 个 Markdown 文件的 188 个本地文件链接，均存在；不包含远程 URL 可达性或锚点验证。`git diff --check` 通过。

## 下一步

下一批迁移 FastAPI 与协议/事件实验，明确选择 committed-message UI 还是支持实时帧的 transport；再验证 V4 日志迁移和 AG-UI 跨 generation 恢复。不要直接给旧项目升级 SDK lockfile，而沿用 `assistant/chunk` 或旧 resume adapter。Phase 7.2 进程池继续按[工程化路线](../learning-paths/engineering.md)推进。
