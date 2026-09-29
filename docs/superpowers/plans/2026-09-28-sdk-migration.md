# SDK 教程迁移执行计划

> **For agentic workers:** Use superpowers:dispatching-parallel-agents for the independent Python and TypeScript directories; use test-driven-development and independent review before completion.

**Goal:** 两套 SDK 教程按实际发行版本重新可运行、可验证。

**Architecture:** Python 与 TypeScript 各自精确锁定 SDK/runtime；公开 profile 启动；committed message 通知投影；共享选型说明由协调者统一。

**Tech Stack:** Python >=3.10 / uv / pytest / Ruff；Node ^22.19.0 || >=24.0.0 / TypeScript strict NodeNext / pnpm / Vitest。

**Spec:** [设计](../specs/2026-09-28-sdk-migration-design.md)

## Global Constraints

- Python `0.1.5rc1`；TS `0.1.7-rc.2`，不得改成漂移版本或 master。
- 不复制第三套 transport；原裸协议例只服务教学。
- 不将 committed notification 称为实时 token；不声称 stock SDK 跨进程 resume。
- 保留此前未提交改动；不 stage、commit、push、不修改 upstream。
- keyless、真实模型、产物与进程观察分别报告。

## Review Focus

- receipt 可先于 prompt response；订阅必须在提交前建立，idle 必须在对应 receipt 后。
- 外部/child/迟到消息不能覆盖 root 输出，EOF 必须结束等待。
- profile 初始化和总活动时限不同；错误不打印 key；失败关闭不能删除仍在使用的 home。
- 默认环境与版本必须正确，foreign cwd 与 `--help` 不触发模型或初始化。
- 工具文件缺失、错字节或模型 error 必须导致验证失败。

### Task 1: Python 六例与双语章节

**Files:** `tutorials/python-sdk/`。

**Interfaces:** 保留六个脚本入口；采用 `profile` / `patches` / `dsh_home`；通知投影返回 root committed text；源码说明引用 Python 发行 tag。

- [x] 核对安装 wheel 和官方类型；写 migration 回归并观察失败。
- [x] 精确依赖 pin 和 uv.lock；更新六例、测试及所有章节。
- [x] pytest / Ruff / format；实跑六例、字节核对与外部进程回收；记录命令和失败。

### Task 2: TypeScript 四例与发布包 launcher

**Files:** `tutorials/typescript-sdk/`。

**Interfaces:** `resolveRuntimeLaunch` 返回公开 `HarnessClientOptions`，同版本 npm 包作为版本依据；所有 consumer 同步更新。`NotificationProjection` 输出最后一条 root committed message。

- [x] 写新公开 launch / committed projection / EOF 回归并观察失败。
- [x] 更新 package/lock、launcher、四例和 fake runtime，删除只服务旧 source launch 的逻辑与测试。
- [x] tests / typecheck / lint / format；四例真实运行，文件字节与进程回收单独确认。

### Task 3: 选型、导航与统一验收

**Files:** `docs/comparisons/python-vs-typescript-sdk.md`、`docs/learning-paths/{python-app-builder,typescript-runtime-builder,engineering}.md`、`README.md`、`tutorials/README.md`、`docs/reviews/2026-09-28-sdk-migration.md`。

**Interfaces:** 消费两组实际版本与验收结果；其他历史项目的 pin 不变。

- [x] 明确各课程当前版本和 notification/stream/resume 的支持范围。
- [x] 独立 review 两个目录，修复重要问题并执行相关回归。
- [x] 检查本地链接、diff、版本遗留；记录完整命令和后续起点。
