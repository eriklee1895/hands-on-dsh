# 2026-09-28 执行记录

本文件记录第一批结束时的状态；后续 SDK 升级见[第二批记录](2026-09-28-sdk-migration.md)。

本批交付：[上游 review](2026-09-28-upstream-refresh.md)、[工程化路线](../learning-paths/engineering.md)、[7.1 runtime supervisor 实验](../../labs/runtime-supervision/README.md)。设计和任务状态见[执行计划](../superpowers/plans/2026-09-28-curriculum-refresh.md)。

## 已完成与未完成

已完成课程相关接口 review、旧版入口提示、第一课实现与下列验证。旧 Python/TS/FastAPI/Cordis/AG-UI 项目依赖未升级，7 篇历史机制笔记正文未改写；Phase 1–6 新版迁移、Phase 7.2–7.7 仍待完成。未修改 DSH upstream，未 stage、commit、push。

## 发布与源码核对

- `gh api repos/deepseek-ai/deepseek-harness/releases`：最新 published prerelease 为 `dsh-v0.1.7-rc.2`。
- `git ls-remote origin refs/heads/master 'refs/tags/dsh-v0.1.7*'`：发布 tag `477b4f420553e8a52c2fbccc464d7561b239c443`，master `21638c56315ae6a2b552d6091945d3144c9af32e`。
- npm registry：SDK/protocol `next=0.1.7-rc.2`，`latest` 仍为 `0.0.1-rc.1`。
- PyPI JSON：SDK/runtime 最新 `0.1.5rc1`，无 `0.1.7rc2`。
- Context7 仅用于定位官方资料；最终判断逐项回到固定 tag 的源码。

## 第一课验证

工作目录为 `labs/runtime-supervision`；macOS arm64，实际 Node `26.7.0`、pnpm `12.3.4`。这里记录当日观察，不表示平台矩阵均已覆盖。

| 命令/检查 | 结果 | 范围 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 通过 | 精确发布版本与锁文件；首轮 install 因未声明 build scripts 失败，检查相关脚本后在本项目 allowBuilds 中逐项声明 |
| `pnpm test -t 'starts lazily'`，实现前 | 预期失败：Not implemented | 观察到缺失行为，随后实现 |
| `pnpm test` | 20 tests passed（独立 review 修复后） | fake runtime/fake timers，不访问模型 |
| `pnpm typecheck` | 通过（最终检查） | 本项目 strict TypeScript |
| `pnpm lint` | 通过（最终检查） | Oxlint |
| `pnpm smoke` | exit 0，initialize 与 close 成功 | 真实发布的 sdk-minimal runtime，不提交 prompt，不能视为模型 E2E |
| `pnpm exec node --env-file=<本地凭据文件> --import tsx examples/run.ts` | exit 0；`runtime supervision ok`；`turnEnd.kind=completed` | 一次真实模型调用；session ID `session-6437c1693e4b47cc879fbac273908e98` |
| 外部进程观察 | 4 个 observed descendants，结束后剩余 0 | 每 100ms 通过 ps 追踪 owned process 的后代；无法证明从未观察到的短命/逃逸进程 |

最终 `pnpm format:check`、`git diff --check` 通过；本仓库 51 个 Markdown 文件中的 172 个本地文件链接全部存在（未验证 URL 可访问性或锚点）。独立 reviewer 复核固定 tag 源码及本批代码，发现 1 个 P1 并发问题：cleanup 成功提前设 idle，让新调用进入后被旧调用的 finally 清除状态。新增 `keeps admission closed until failed activity has released its slot` 测试先失败（expected running, got idle），修复为 cleanup 保持 stopping、旧调用释放 timer/interrupt 后才恢复 idle；随后 20 tests、typecheck、lint、format 全部通过。review 范围内无其他待修问题。

上述真实模型调用发生在这次微任务竞争修复之前；修复后的证据是 keyless 回归与静态检查，未重复调用模型。

## 下一批起点

先迁移 Python/TypeScript 入门，分别采用实际可安装的发布版本；不要改变本批已验证的固定版本来追逐 master。优先处理 profile/home/patch 与旧 session-root 参数，再明确 SDK committed output 与实时 token 的区别。之后迁移 V4 日志、FastAPI/AG-UI projector 和 resume adapter，逐项恢复真实 E2E；7.2 进程池在此基础上扩展。
