# 容器 workspace 与 SSH 远程执行验收

实现于 2026-10-01 晚，最终检查于 2026-10-02 凌晨。实验入口为 [第 7.4 课补充](../../labs/sandbox-isolation/CONTAINERS.md)，在本机 OrbStack Docker `29.4.0`、Linux arm64 容器上执行。DSH npm 包固定 `0.1.7-rc.2`，源码核对固定 tag `dsh-v0.1.7-rc.2` / commit `477b4f420553e8a52c2fbccc464d7561b239c443`。

## 实际执行

在 `labs/sandbox-isolation` 运行 `pnpm container`，退出码 `0`。本次容器 Node `v22.23.3`、有效 UID `10001`。Docker inspect 确认仅 A 挂载到 `/work`、只读根、丢弃所有 capabilities、`no-new-privileges`、PID/内存/CPU 上限 64/256 MiB/1 核、两处私有 tmpfs、独占网络和只在 `127.0.0.1` 发布的 SSH 端口。SSH host key 和客户端密钥均为本次临时生成；客户端使用独立 known_hosts。

| 探针                                           | 实际结果                                |
| ---------------------------------------------- | --------------------------------------- |
| `docker exec` 直接写 `/work/direct.bin`        | 退出码 0，宿主字节核对通过              |
| loopback SSH 写 `/work/ssh.bin`                | 退出码 0，宿主字节核对通过              |
| 固定版 `SshFileSystem` 写 `provider.bin`       | helper 握手成功，宿主字节核对通过       |
| 固定版 `SshSubprocessRuntime` 写 `process.bin` | 退出码 0，宿主字节核对通过              |
| 从容器读 B、通过 A 符号链接读 B                | 退出码均为 1                            |
| 从容器写 B、通过 A 符号链接写 B                | 均失败；B canary 字节未变，没有新增文件 |
| 远程 filesystem provider 读 B                  | `FS_NOT_FOUND`                          |
| 结束清理                                       | 本次容器、网络、镜像及临时目录均不存在  |

本次 `provider.bin` 实际字节（hex）：`6532376263353634656461393334383731613437326638373939376461346537`。镜像 ID `sha256:fc73cbe2965b27688bb141e5042bf6cc0570f7dd56f5bd3dea484a755879b9f9`；容器内 helper SHA-256 `42373bff731239ab5e50bfd908fba8d7e9b9f127463586fa346715135a8ada0b`。每次运行 nonce 和镜像 ID 均变化。

## 检查与自审

| 命令                            | 结果                                                                      |
| ------------------------------- | ------------------------------------------------------------------------- |
| `pnpm container:test`           | 3 个真实 Docker/SSH/provider 测试通过：正常路径、创建后启动失败、删除失败 |
| `pnpm test`                     | 4 files / 11 tests 通过；3 个 Docker opt-in 测试跳过                      |
| `pnpm typecheck`                | 通过                                                                      |
| `pnpm lint`                     | 通过，无 warning                                                          |
| `pnpm format:check`             | 通过                                                                      |
| `pnpm build`                    | 通过                                                                      |
| `bash -n examples/container.sh` | 通过                                                                      |

测试先因脚本缺失而失败；实现后曾发现镜像名大小写、OrbStack internal network 不发布端口、helper 缺少 peer dependencies、临时路径双斜线与 Docker mount 规范化路径比较问题，逐一修复并重跑。独立审查指出启动失败可能已创建容器，而旧清理标记仍为 0；新增两项注入真实 Docker 资源的回归先观察残留和吞掉清理失败，再改为按独占名称与标签清理。删除失败会明确报错、保留临时目录，并先删除私钥。自审将远程 B 读取错误收窄为 `FS_NOT_FOUND`，避免把任意 SSH 故障误记为隔离拒绝。正常运行后的 Docker 标签过滤无遗留资源；未改用户容器、daemon 或 `~/.ssh`。

## 证据范围

这证明在本次配置中，容器不可见未挂载的 B，固定版 SSH 文件与子进程 provider 可在同一个远程 `/work` 写出真实产物。helper hash 来自同一个容器，只证明握手期间的文件字节一致，不提供独立的镜像来源校验。`SshSandboxProvider` 已挂载但未调用 `confine()`，未验证 bwrap/Landlock 的额外策略。模型回合、完整 headless profile、网络出口封锁、宿主 DSH runtime/插件、容器内核逃逸和生产多租户调度均未验证。bridge 网络可能有出口；不能把这个结果解释为网络隔离或整体多租户安全保证。

固定源码参考：[SSH provider 部署条件](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/ssh/ssh/README.md)、[SSH 执行坐标](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/docs/subsystems/ssh.md)、[公开 provider 组合测试](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/ssh/ssh/tests/live.e2e.ts)。

最终独立复核确认：资源按独占名称和双标签清理，启动/删除失败路径有真实Docker回归；PID/内存/CPU/tmpfs均由inspect硬断言。两处P2均已关闭，无剩余P1/P2。
