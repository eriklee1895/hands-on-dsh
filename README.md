# Hands-on DSH

从 Python 发出第一条请求，到构建能记录任务、恢复会话、核对工具产物的 Agent 应用。这套课程把 DeepSeek Harness（DSH）放进一个个可以运行的小项目中：先观察它做了什么，再读源码解释为什么会这样。

DSH 是基于 Cordis 的 Agent runtime。模型、工具、会话日志、执行循环和客户端都由插件组合。学习时先记住两件事：你的程序需要管理 runtime 的生命周期；模型说“完成了”之后，还要检查任务状态和外部结果。后面的服务、协议和恢复实验都从这里展开。

## 从哪里开始

第一次接触 DSH，可以顺着[全章导航](docs/learning-paths/chapters.md)学习。已有应用目标时，选择一条更短的路线：

| 你的目标 | 从这里开始 | 最终会做出的东西 |
| --- | --- | --- |
| 用 Python 接入 Agent | [Python App Builder](docs/learning-paths/python-app-builder.md) | SDK 调用、FastAPI 页面、持久任务与产物服务 |
| 在 Node 应用中管理 runtime 和插件 | [TypeScript Runtime Builder](docs/learning-paths/typescript-runtime-builder.md) | SDK 示例、Cordis 工具、React/AG-UI 应用 |
| 理解执行、日志与上下文为什么这样工作 | [七篇机制章](how-dsh-works/README.md) | 能沿固定源码解释一次输入、工具执行和会话恢复 |
| 处理超时、并发、隔离与回归 | [工程化七课](docs/learning-paths/engineering.md) | supervisor、进程池、租户 API、隔离实验、观测、eval 与适配层 |

每条路线都提供可运行代码。入门课从一个成功任务开始；进阶实验会主动制造超时、断线或崩溃，让你同时看见日志、外部文件和调用方结果，理解它们为什么可能不一致。

## 先跑一个 Python 请求

从仓库根目录执行。需要 uv，并在被 Git 忽略的根 `.env` 中设置自己的 `DEEPSEEK_API_KEY`。环境与可选模型参数见[Python 安装说明](tutorials/python-sdk/README.zh.md)。

```sh
uv sync --project tutorials/python-sdk --group dev
uv run --project tutorials/python-sdk --env-file .env python tutorials/python-sdk/01_hello.py
```

先看最终文本和结束原因，再确认程序退出时 runtime 已关闭。接着进入[第二章](tutorials/python-sdk/tutorials/02-reuse-session.zh.md)，让同一个存活进程连续回答两轮，观察 Session 怎样保留上下文。

如果想直接看浏览器应用，从仓库根目录开启另一个终端：

```sh
cd tutorials/fastapi-101
uv sync --group dev
uv run --env-file ../../.env python -m dsh_fastapi_101
```

访问 `http://127.0.0.1:8000/chapter/1`。页面用于动手实验，章节阅读链接在 GitHub 打开图文说明。当前 SDK 下发的是已提交消息与状态、工具事件；逐 token 的实时输出在[官方 Web 实验](labs/web-host-lifecycle/README.md)中单独学习。

## 版本与课程完成范围

课程按发行版本固定依赖，运行前以所在目录的 manifest 和 lockfile 为准。

| 课程 | 固定版本 | 源码依据 |
| --- | --- | --- |
| Python SDK、FastAPI、可恢复服务 | Python SDK/runtime `0.1.5rc1` | `dsh-v0.1.5-rc.1` |
| TypeScript、协议、插件、AG-UI 与机制实验 | npm DSH `0.1.7-rc.2`，Cordis `4.0.4` | `dsh-v0.1.7-rc.2` |
| 跨引擎适配 | 另记 Codex/Hermes 的实测 CLI 版本 | [适配章节](labs/protocol-semantics/ADAPTERS.md) |

既定 Phase 1–7，以及列明的附件、容器、跨引擎和恢复扩展，均已完成对应代码、章节及限定场景验收。逐项证据由[全章节验收索引](docs/reviews/2026-10-01-chapter-audit.md)集中维护；[上游变化审查](docs/reviews/2026-09-28-upstream-refresh.md)解释本轮版本选择。

这里的“完成”对应每章声明的版本、平台和实验条件。全部平台、任意时点掉电恢复、生产多租户安全和一般模型质量，需要按实际部署继续验证。各章会指出具体尚未覆盖的部分，历史验收也保留原日期。

## 代码放在哪里

- [tutorials](tutorials/README.md)：Python、FastAPI 和 TypeScript 的渐进练习。
- [projects](projects/README.md)：可恢复 Agent 服务与 AG-UI 完整应用。
- [labs](labs/README.md)：用最小实验研究某个机制或故障。
- [how-dsh-works](how-dsh-works/README.md)：从现象追到固定 revision 的源码。
- [comparisons](docs/comparisons/README.md)：在语言、协议、恢复和传输之间作选择。

同一个事实和实现尽量只有一个归属。学习路线负责串联，实验负责运行，验收记录负责保存当时观察。阅读过程中可沿链接深入，不需要先通读所有设计与历史记录。

## 运行实验时

先跑所在章节的无 Key 检查，确认环境与确定性案例，再按说明运行真实模型任务。Python 项目使用 uv 和 Ruff，TypeScript 项目使用各自锁定的 pnpm 工具链；验证命令由项目 README 持有。

工具实验只针对可丢弃 workspace、容器或明确的 sandbox。`sdk-minimal` 的宿主权限较宽，独立目录只是产物位置；自定义 plugin 也可能拥有宿主权限。运行前读清章节的权限说明。AG-UI 项目定位为单用户、loopback 开发应用；租户 API 与容器课分别检验自己的范围。

API Key、token、原始账户状态和个人 Session 日志留在本地。共享结果时使用章节中的白名单证据和文件校验。遇到超时或断线，先确认原任务与外部状态，再决定后续工作。

本仓库是个人学习项目。机制解释链接到 [DeepSeek Harness 官方源码](https://github.com/deepseek-ai/deepseek-harness)，不复制其核心实现。
