# Python 与 TypeScript SDK 教程迁移

## 目标

接续已完成的上游 review 与 7.1 lab，在原 worktree 更新两套 SDK 教程，使当前脚本、章节、依赖和运行结果一致。用户已同意继续执行；FastAPI、协议 lab、Cordis 和 AG-UI 保持原版本，后续批次迁移。

## 固定版本与行为

- Python 使用 PyPI `deepseek-harness-sdk==0.1.5rc1` 和匹配 runtime wheel，源码 tag `dsh-v0.1.5-rc.1` / `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。保持 Python >=3.10、uv 与 Ruff，实际 API 以安装 wheel 和对应源码双重核对。
- TypeScript 使用 npm `0.1.7-rc.2`，源码 `477b4f420553e8a52c2fbccc464d7561b239c443`。采用公开 SDK 的 profile/home/patch 与同版本 dsh resolver，去掉准备旧 source checkout 的要求。
- Python 六例、TS 四例保留学习顺序。第三例讲通知投影：输出 root committed assistant message，不伪造逐 token streaming；具体 payload 按各自版本核对。
- 第四个 Python 示例与第三个 TS 示例必须比较真实工具产物字节；模型自述不作为成功证据。
- 所有独立示例使用独立 home/workspace，关闭确认后才清理；同一示例内 session 复用与跨进程 resume 分开描述。
- 裸 JSON-RPC 使用公开 dsh profile 入口；处理 receipt、root/child 过滤、异常 EOF、超时与关闭，不使用私有 launch/test factory。

## 验证与文档

先记录旧行为的失败，再更新实现与覆盖目标行为的测试。keyless tests 使用公开 SDK 配置或明确注入的教学 fixture，不能依赖 SDK 内部测试出口。真实模型验证由两套教程分别记录；工具输出和 runtime 进程回收由调用之外的代码/进程观察确认。

每个 README 和章节都必须与代码一致，不留下旧 `session_root`、`DSH_CORDIS_CONFIG`、`launch.command/args` 或 `assistant/chunk` 的现行使用说明。历史验收带日期单列；比较文档明确两种不同发行版本。验证某个脚本失败时先定位，不改换任意 master 或声称旧成功记录适用。

## 变更归属

Python 子任务只修改 `tutorials/python-sdk/`；TS 子任务只修改 `tutorials/typescript-sdk/`。协调者更新 `docs/comparisons/python-vs-typescript-sdk.md`、两条 learning path、根 README、tutorials/README、lab 的交叉引用和新验收记录。共享根目录和 `.env` 不交给子任务写入。所有改动留在现有分支，不 stage、commit、push。
