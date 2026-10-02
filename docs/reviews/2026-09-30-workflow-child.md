# Workflow PTC 与 child 冷恢复验收

日期：2026-09-30。基线 `a8c49a7`；新增 [Lab](../../labs/workflow-child-lifecycle/README.md)，固定 npm `0.1.7-rc.2` / Cordis `4.0.4`，源码 `477b4f420553e8a52c2fbccc464d7561b239c443`。本机 macOS arm64、Node `26.7.0`、pnpm `12.3.4`。

## 源码与受控运行

核对 `workflow-ptc` host、PTC provider、subagent continuation、descriptor/catalog 和 SDK profile。workflow helper 创建 one-shot children；continuable cold resume 需要 sessionQuery、可恢复 descriptor 及 exact live parent。取消后的 workflow result 本身会等待清理，不能先 await result 再释放受控 provider 的 publication gate。

初始实验函数占位时两个行为测试失败；实现后实际 Node PTC 和跨 Context JSONL 恢复通过。证据验证器占位时，修改历史前缀和缺失工具调用的负对照失败；加入验证后通过。另有 script failure、非父会话拒绝、取消后的 late-start disposal 案例。最终检查结果见下表。

| 检查 | 结果 |
| --- | --- |
| Lab tests | 8 项通过；真实 PTC/AgentLoop/JSONL，模型响应受控 |
| typecheck / build | 通过 |
| lint / format / frozen install | 通过 |
| 相对链接 / Mermaid | 9 篇变动 Markdown、89 个相对链接、2 个图表通过 |
| 独立复核 | 代码与最终文档均无 P1/P2；reviewer 独立运行原 6 项测试，随后新增 2 项工具证据负对照由主执行者验证 |
| 暂存 diff / credentials | `git diff --cached --check` 通过；21 个文件凭据模式命中 0，未暂存原始日志或运行目录 |

组合过程中发现缺失 Session Query；加入发行包后解决。pnpm 增量安装曾生成失效 peer 链接，最终从完整 manifest 重建锁文件和 Lab 依赖目录；没有编辑发行包或手工固定 node_modules 链接。

关闭失败另做了无 Key 注入：SDK start/close 同时抛出受控错误，确认 `closed: false`、保留目录存在、路径被报告、原始错误不回显；没有启动 runtime 或调用模型。

## 真实运行

先执行 `pnpm build`，再从 Lab 目录使用 Node `--env-file` 加载已有本地凭据执行 `examples/live.ts`。凭据不进入源码、报告或提交。整个真实模型实验运行一次，程序未自动重放实验任务。

| 观察 | 值 |
| --- | --- |
| runtime PID | `76141`，关闭后新建 `76604` |
| parent ID | `parent-95fdba9d-c736-4908-b0d0-b3001716d6f0` |
| continuable child ID | `child-a80c22aa-ef47-49d9-8ba1-5127e7ba0654` |
| workflow writer / reader | `3dc385f1-8205-4290-8631-565ba7457478` / `b65d822d-b35d-45b3-9c71-1921a66c6485` |
| child 持久事件 | `14 → 31`；原前缀逐项相同 |
| child 终态 | 两个 completed turns；第二次追加的消息来源为原父 |
| workflow 文件 | 37 字节；SHA-256 `11078d59c568d7c8f49edba0ff855b51bfaf952d0502237c2c208be1084b28fc` |
| 冷恢复文件 | 39 字节；SHA-256 `b2411b485fc9eb3f72006b68ae60e504887d0209dd3a31c7175d957a47f2cc80` |
| 工具证据 | writer、reader、恢复 child 各一次精确 Bash call/result；首个 continuable turn 无工具 |
| 第二次输入 | patch 和新增 user/message 均不带记忆口令 |
| 持久化 | runtime close 后独立公开 JSONL backend 读取 V4；header/descriptor/catalog 核对 |
| 清理 | 两次 SDK close 完成；成功临时目录删除 |

200ms 外部进程采样：峰值后代 7，profile runtime 峰值 1，PTC 进程峰值 1；累计观察 14 个后代 PID，结束后仍存在 0。两个 profile 顺序执行，未同时保持两个 owner。原始白名单输出与采样保存在忽略的本地实验目录，未提交原始 Session 日志。

## 结论范围

这是公开 profile 加课程 plugin 的 host service 实验：正常关闭之后，原父可以恢复同一个 continuable child 并使用其持久上下文完成新任务。workflow 的两个一次性 child 真实完成文件任务。无 Key 测试还观察了脚本失败与取消清理。

没有验证 SDK 原生 resume、模型生成 workflow 脚本、tool-workflow durable UI 事件、SIGKILL/crash recovery、复杂并行/retry、整个 child forest、外部 provider、全平台清理或恶意脚本隔离。父 pre-step 被实验拒绝以抑制 settlement 通知带来的额外模型调用；父 turn 不作为业务成功指标。冷恢复的输出 token 上限来自模型默认值，512 不写入 descriptor，不能作为第二次 activation 的预算保证。
