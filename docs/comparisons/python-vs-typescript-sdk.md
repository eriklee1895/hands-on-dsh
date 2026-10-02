# Python SDK 与 TypeScript SDK

已经在 Python 跑通一个请求后，把它移到 Node BFF 看似只是改写语法。真正要先核对的是 runtime 从哪里来、环境变量怎样传入，以及同名 SDK 方法到底能做什么。

本页比较课程当前采用的两种发行版本：Python `deepseek-harness-sdk==0.1.5rc1` 与 TypeScript `@deepseek-ai/dsh-sdk-client@0.1.7-rc.2`。这不是同版本性能对比；发行渠道不同步，不能把某一侧的能力或数据格式推断到另一侧。[版本验收](../reviews/2026-09-28-sdk-migration.md)单独记录运行范围。

## 如何选择

Python 适合 Python 后端和快速入门：平台 wheel 提供带 Node 的 runtime，使用 uv 管理即可。TypeScript 适合 Node BFF 与前端共用语言的项目：SDK 已能解析同版本 npm `dsh`，无需像旧教程那样准备 source checkout 和手写 runtime command。两者都通过公开 profile 选择和 patch 定制应用。

语言选择不能补齐 wire 能力。需要即时 cancel、permission 时应另查 ACP；需要持久业务恢复时，应用仍然拥有 Conversation、Run、Approval 与 Artifact 状态。SDK 的 session ID 不是业务执行结果。

## 能力矩阵

| 维度 | Python 教程 | TypeScript 教程 |
| --- | --- | --- |
| SDK/runtime 版本 | PyPI `0.1.5rc1` | npm `0.1.7-rc.2` |
| 固定源码 | `dsh-v0.1.5-rc.1` / `183f08e9c6dde7e36cd2318eaee70b0da08fb35e` | `dsh-v0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443` |
| Runtime 来源 | `deepseek-harness-runtime-bin` 平台 wheel | SDK 的同版本 `@deepseek-ai/dsh` dependency，需要 Node |
| 公开启动配置 | `profile`、`patches`、`dsh_home`、`runtime_cwd`，可选 `dsh_bin` | `profile`、`patches`、`dshHome`、`processCwd`，可选 `dshBin` |
| 环境语义 | `env` 合并到继承的父环境；不自动清空其他变量 | 显式 `env` 整体替换父环境；省略时继承 |
| 高层 API | 同步 `DeepSeekHarness` / `Session.run()` | Promise 风格 `DeepSeekHarness` / `HarnessSession.run()` |
| 低层 API | `HarnessClient` | `HarnessClient` |
| 通知 | `on_notification`，Notification 使用 `payload` | `onNotification`，Notification 使用 `params` |
| 本课文本观察 | root `assistant/message` 的已提交文本 | root `assistant/message` 的已提交文本 |
| 活动结算 | 对应 Inbox receipt 到 whole-agent idle | 对应 Inbox receipt 到 whole-agent idle |
| 最终回复 | `RunResult.final_response` | `RunResult.finalResponse` |
| 模型终态 | `finish_reason` 从 `turn/end` 提取 | 从 `events` 的最后一个 root `turn/end` 提取 |
| Session writer | V3 | V4 |
| 官方模型传输 | 该发行版仍为 Chat Completions | 该发行版为 Messages/Files |
| SDK wire cancel / approval / resume | 无公开对应方法 | 无公开对应方法 |

## 启动与版本

Python 的 `dsh_home` 必须显式传入，或由非空 `DSH_HOME` 提供；该 SDK 不隐式使用个人 `~/.dsh`。TypeScript SDK 默认解析同版本 npm dsh；本教程也传独立 `dshHome`。`profile: sdk-minimal` 是上游提供的完整 profile，不等于调用方传完整 Cordis tree。

部署仍要拥有 runtime 版本、home、patch、workspace 和进程生命周期，但不需要另写 SDK transport 或启动私有 package bin。Python 的 bundled executable 与 TypeScript 的 Node CLI module 不是同一种文件，不能交换 `dsh_bin` / `dshBin` 路径。

两边的默认 provider endpoint 也不同：Python 对应源码的 root 为 `https://api.deepseek.com`；TS 对应源码的 root 为 `https://api.deepseek.com/anthropic`。设置 `DEEPSEEK_BASE_URL` 时先确认网关支持该版本的协议；不要因为变量名相同就复制同一个 URL。凭据不写入教程或版本库。

## 同一个 env 参数，传递的内容可能不同

假设父进程同时有模型凭据与其他服务变量。给 Python SDK 的 `env` 只增加一个变量，其余父环境仍会继承；给 TypeScript SDK 显式传一个只含该变量的对象，则会替换子进程环境。迁移代码时只复制这个对象，可能让 runtime 丢失所需变量。

先明确哪些变量允许进入子进程，再按各自语义构造环境。调用方还要负责通过命令或配置加载 `.env`；一个文件存在于磁盘上，不表示后续所有 shell 命令都已继承其中的值。

## 通知流不等于逐 token 输出

这两个固定版本都不再把 `assistant/chunk` 作为独立 durable event。进程内实时帧走 `agent/assistant-stream`，持久 stream 嵌入 `assistant/message.stream` / `assistant/attempt.stream`；当前 SDK server 没有转发这条进程内实时事件。

因此第三个示例展示的是通知到达后投影 root 已提交消息。它可以收到工具、status、subagent 与已完成消息，但不能据此承诺边生成边逐字更新。收到一条 committed message 后把它拆成字符发送给浏览器，也不会变成真实 token streaming。

最终回复取活动区间最后一条 root assistant message；不混入 child 文本，不把中间消息与最终消息拼接成重复回答。当前 FastAPI 和 AG-UI 项目都保留这种已提交正文语义。需要边生成边显示时，转看[官方 Web 的独立实时帧](../../labs/web-host-lifecycle/README.md)，再决定采用哪条入口。

## 生命周期与恢复

低层 client 先订阅，再提交 prompt，接收对应 message ID 的 durable Inbox receipt 后才收集到 root idle。receipt 可能早于 prompt response 到达，不能在拿到 response 后才开始订阅。裸协议客户端在 response 迟到时还可能已经收到了后续活动的通知，文本和 `turn/end` 都必须限制在对应 receipt 到首次 root idle 的同一区间，不能让后续终态覆盖它。idle 表示整个 agent 不再欠工作，并不提供每个并发输入的独立结果。

同一 runtime 内复用 session 与跨进程恢复是两件事。这两个版本的 stock SDK server 都会为未知 session 创建 Agent，没有公开 resume RPC。当前 [AG-UI 项目](../../projects/ag-ui-dsh-runtime/README.md)固定 npm `0.1.7-rc.2`，通过自己的 deployment adapter 检查持久记录与 cwd，再显式调用 `agents.resume()`。这项项目能力没有改变 stock SDK 的方法集合。

Python 使用 context manager 或 `close()`；TypeScript 使用 `try/finally`、`close()` 或 `await using`。二者的 close 实现和超时配置不同，不应声称回收所有工具后代进程。正常退出的外部进程观察只覆盖当次被观察到的 PID。业务层对 timeout/断线仍需记录执行不确定，不能自动重放可能有副作用的 prompt。参见 [runtime supervisor](../../labs/runtime-supervision/README.md)。

## 验证与真源

两套 SDK 的真实运行、外部产物与 keyless 检查见[SDK 迁移记录](../reviews/2026-09-28-sdk-migration.md)。阅读源码时用下面各自的 revision；2026-08-31 的旧版记录保留原日期，不作为新版能力依据。

- [Python 教程](../../tutorials/python-sdk/README.zh.md)与[对应 client 源码](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/python/sdk/src/deepseek_harness/client.py)。
- [TypeScript 教程](../../tutorials/typescript-sdk/README.md)与[对应 launch resolver](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/client/src/launch.ts)。
- [Python 版本 SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/sdk/server/src/server.ts)与[TS 版本 SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/sdk/server/src/server.ts)。
- [Python 版本 provider](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/llm/llm-deepseek/src/index.ts)与[TS 版本 provider](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/README.md)。
