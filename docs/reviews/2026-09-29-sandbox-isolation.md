# Phase 7.4：本机 sandbox 与真实工具探针

2026-09-29 完成 [sandbox-isolation lab](../../labs/sandbox-isolation/README.md)。固定版本的 macOS `workspace-write` 拒绝了外部写入，但仍允许读取实验的外部 canary、访问自有环回 HTTP server 和通过 signal 0 检查自有父 PID。它不是完整的租户执行隔离。

基线 `9761a68`，新增独立 lab，没有改动上游或现有业务服务。设计与执行项见[设计](../superpowers/specs/2026-09-29-sandbox-isolation-design.md)、[计划](../superpowers/plans/2026-09-29-sandbox-isolation.md)。

## 固定版本与源码依据

macOS arm64，Node `26.7.0`、pnpm `12.3.4`，SDK/runtime/sandbox packages 精确锁定 `0.1.7-rc.2`，Cordis `4.0.4`。源码审查固定为 `dsh-v0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`，不使用当前 checkout HEAD 推断发行能力。

- [SandboxMode](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sandbox/sandbox/src/index.ts)是文件效果词汇，网络与进程可见性在其范围之外。
- [Seatbelt profile](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sandbox/sandbox-local/src/profiles.ts)在 allow-default 基础上拒绝 file-write，再授予 workspace/temp 子树。
- [writableRoots](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sandbox/sandbox/src/roots.ts)包括 canonical workspace、`/tmp` 与 `os.tmpdir()`，因此 outside fixture 位于 HOME 下独占目录，避开全部 temp grant。
- [TerminalBashBackend](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/terminal/terminal-bash/src/index.ts)在 shell 创建时解析 session policy 并 confine；[持久 Bash 工具](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/shell/tool-bash-persistent/src/index.ts)只有 command 参数。

## 本地检查

以下在 `labs/sandbox-isolation` 执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm test` | 4 files、11 tests 通过 |
| `pnpm typecheck` | strict NodeNext 通过 |
| `pnpm build` | 生成 plain Node worker，通过 |
| `pnpm lint` | 通过，无 warning |
| `pnpm format:check` | 通过 |
| `pnpm install --frozen-lockfile` | 通过，锁文件不变 |
| `pnpm probe` | 真实 provider 三模式通过，修复清理逻辑后重新执行通过 |

worker 的 5 个测试使用真实文件和环回服务验证输入、canary 与基础操作；2 个结果验证测试拒绝缺失字段、错误 nonce 和把 ENOENT 当作拒绝；3 个命令测试检查退出结果、缺失程序、超时及残留 group；1 个 fixture 测试覆盖第二目录创建失败后的部分回收。这些不调用模型，和下面的 Seatbelt / SDK 证据分别报告。

文档检查：1 个 Mermaid 图通过 Mermaid 11.16.0 解析，变更文档的 51 个本地文件链接均存在，`git diff --check` 通过。

## 真实 provider 矩阵

| 操作 | 未限制对照 | read-only | workspace-write |
| --- | --- | --- | --- |
| inside write | allowed | denied/EPERM | allowed |
| outside read | allowed | allowed | allowed |
| outside write | allowed | denied/EPERM | denied/EPERM |
| symlink write to outside | allowed | denied/EPERM | denied/EPERM |
| descendant write to outside | allowed | denied/EPERM | denied/EPERM |
| temp write | allowed | denied/EPERM | allowed |
| loopback HTTP | allowed | allowed | allowed |
| parent PID signal 0 | allowed | allowed | allowed |

所有模式都核对实际字节与文件缺失；不是根据模型输出判定。受限行实际 runner 为 `sandbox-exec`，provider 报告 `enforcement=full`，其含义仅限承诺的文件效果。显式未限制行使用原 Node argv，确认实验本身可执行；受限失败不会走这条对照路径。

清理修复后的最终一次 provider PID 为 `19164 / 19176 / 19188`，各命令均完成并确认自有 group 不存在，fixture 已删除。原始本机输出在被忽略的 `.superpowers/sdd/2026-09-29-sandbox-isolation/provider-final.log`。

## 两次真实模型工具调用

执行 `pnpm exec node --env-file=<ignored .env> --import tsx examples/model.ts`，使用公开 sdk-minimal + sandbox-policy patch，每种模式全新 runtime、Session、HOME 与 dshHome，模型 `deepseek-flash`。两次都精确调用一次 Bash，根 turn completed，tool call/result ID 匹配；命令 JSON 仅包含预定 command，无额外权限字段。八项结果分别与上表两种受限模式一致，实际文件验证通过。

| 模式 | session ID | tool call ID |
| --- | --- | --- |
| read-only | `session-396a2517034f4130890eb8d9ccb957a6` | `call_00_wbPlq7AJqHHCaPYkKAkW0117` |
| workspace-write | `session-0f4863e7f4f345b1888e4dbe3b82eb47` | `call_00_L1LIJzOUctsVE5uKZTKo8278` |

外部观察器每 200 ms 采样父子进程：累计 14 个后代 PID，峰值同时 6 个；两个模式顺序执行，峰值 DSH profile 进程为 1。父命令退出码 0，退出后这 14 个已观察 PID 全部不存在。采样并不覆盖短于间隔的进程或脱离父子树的后代。日志和采样保存在本机忽略目录的 `real-run.log`、`processes.json`，没有把 `.env` 或凭据写入提交。

模型运行后仅修复了探针的 process-group 回收和 fixture/setup 异常清理，没有改变 worker 操作、策略 patch 或工具验证；这些修复通过回归测试、独立复现及最终真实 provider 矩阵验证，没有额外重复模型调用。

## Review 与限制

独立 review 找到两个 P2，并已修复：主进程成功退出时可能遗留自有 group 中的后代；模型示例在进入 finally 前的 setup 失败可能留下环回 listener。新增测试先观察失败，再验证修复。reviewer 重跑原孤儿进程复现，确认拒绝结果且自有 group 为 ESRCH；11 项测试通过，无待修问题。

本课只验收 macOS。Linux bwrap/Landlock 和 Windows ACL 为固定源码对照，未运行；没有容器、虚拟机或远程 executor 集成。硬链接、任意 native plugin、主动脱离进程组、资源耗尽及全部网络行为未覆盖。DSH runtime 和宿主插件不在被限制的 Bash 子进程内部，不能根据这份结果宣称整套服务已实现安全的多租户执行。

工程化路线将 7.4 本机课程标为完成，并保留容器/远程执行待扩展。下一课为 7.5 可观测性与成本。
