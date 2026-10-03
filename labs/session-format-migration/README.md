# Session V1 / V3 → V4：只读迁移与不可变发布

磁盘上只有一个旧版 Session 文件，新版 DSH 却读出了 V4 事件：它已经修改原文件了吗？本实验把“内存中读到什么”与“磁盘上写了什么”分开观察，再比较 read open 和 write open 的差别。

实验直接挂载发布版 JSONL persistence backend，调用公开的 `ctx.sessionPersistence.open(id, "read" | "write")`，不需要 Agent 或模型。完整 Agent 应用仍从公开 `dsh` profile 启动；这里仅研究存储服务。

## 版本与实验条件

- npm 包：`@deepseek-ai/dsh-session-persistence-jsonl`、`@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-session` 都精确锁定 `0.1.7-rc.2`；Cordis `4.0.4`。
- 上游源码：`dsh-v0.1.7-rc.2`，commit `477b4f420553e8a52c2fbccc464d7561b239c443`。当次发布包含 `lib/worker.cjs`，write open 的 successor 校验确实由已安装 worker 执行。
- Node 支持范围 `^22.19.0 || >=24.0.0`；本次运行使用 Node 26.7.0、pnpm 12.3.4、macOS arm64。项目采用 strict ESM/NodeNext、Vitest、Oxlint、Oxfmt。

从仓库根目录开始，先运行一个 V1 示例：

```sh
cd labs/session-format-migration
pnpm install --frozen-lockfile
node --import tsx examples/run.ts v1
```

留意输出中的 `sourceBytesUnchanged`、`successorBytesStable` 和 `logicalReopenStable`，它们应全部为 true。它们分别回答：旧文件有没有被改、新版文件重开后是否稳定、重读的逻辑历史是否一致。下面会解释这三个观察是怎样产生的。

仍在 `labs/session-format-migration`，再看 V3 并运行本地检查：

```sh
node --import tsx examples/run.ts v3
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

CLI 只接受 `v1` 或 `v3` 两个项目内 fixture 名称，不接受外部日志路径或用户 Session root。每次运行把 fixture 复制到一个新临时 root，完成 backend close 后删除它，不会修改原始 fixture。输出只报告版本、事件类型、文本、SHA-256 和 generation 文件名，不打印临时绝对路径。

## 合成输入和物理布局

`fixtures/synthetic-v1.jsonl` 与 `fixtures/synthetic-v3.jsonl` 是本 lab 手工构造的**合成**历史文件，不是用户资料或真实会话录制。V1 有一轮 user 与 assistant 文本、四条旧 `assistant/chunk` 事件及其 assistant message；V3 有一轮 user/assistant 文本，assistant message 内含当时的 embedded stream。两者都有完整的 turn/step 结束事件。V1 的旧 chunk 行经发布包迁移后折入 V4 assistant message 的 stream；实验没有复制 codec 或 repair 实现。

这里把磁盘上的一份版本文件称为 **generation**。例如 `session.v1.jsonl` 是旧 generation，write open 发布的 `session.v4.jsonl` 是它的 successor，也就是新版文件；两者可以同时保留。

`src/fixture.ts` 的极小路径 helper 只处理这两个固定、仅含安全字符的 ID，按此发行版的 `_no-cwd/<id>/session.vN.jsonl` 布局复制输入：

```text
<fresh temp root>/
  _no-cwd/
    synthetic-v1/
      session.v1.jsonl
      session.v4.jsonl  # 仅 write open 后出现
```

这个 helper 不处理任意 Session ID 的转义规则；该规则由真实 backend 持有。基础演示的物理输入选择 `compression: "none"`，因此可逐行检查并计算源文件 SHA-256。压缩的非空 V1/V3、发布版写出的非空 V4 和附件对象见[复杂历史章节](RICH-HISTORY.md)；两种编码各自使用独立 root，不测试混合编码或编码转换。

## 观察什么

```mermaid
flowchart TD
    A["旧 generation<br/>session.v1/v3.jsonl"] --> B["open(id, read)<br/>逻辑 V4"]
    B --> C["无新文件<br/>源字节不变"]
    A --> D["open(id, write)<br/>发布包迁移与 worker 校验"]
    D --> E["新增 session.v4.jsonl<br/>旧 generation 保留"]
    E --> F["新 backend 再 open<br/>同一逻辑历史"]
```

先看 `read`。打开 V1 或 V3 后，handle 的 header 已经是 V4，`read().events` 包含非空 user/assistant 历史。V1 的顶层 `assistant/chunk` 被折入 assistant 的 embedded stream，共四项；迁移后的 V1 还出现一条 `system/message`。

然后再看目录：仍然只有原 generation，原文件字节和 SHA-256 不变。逻辑格式转换已经发生，但尚未发布新版文件。这就是 `sourceBytesUnchanged` 所检查的区别。

再用 `write` 打开同一 ID，backend 才发布 `session.v4.jsonl`。V1 到 V4 会经过发布包的相邻逻辑转换，磁盘却只新增当前 V4 successor，不要求给每个中间格式都留一个物理文件。V1/V3 输入及其他已存在的较低 generation 都逐字节保留。

最后关闭 backend、重新挂载并读取：V4 逻辑事件相同，successor 字节也不变。demo 会打印三个时点的 generation 列表，便于与布尔结果一起核对。写打开可能留下独立的 `session.lock` 辅助文件；generation 断言只统计规范的 `session.vN.jsonl`。

**拒绝也是结果：** 放入未来版本 `session.v5.jsonl` 后，read/write 都拒绝；即使较旧 V1 可读也不会回退。把最高 V4 generation 改为完整但无效的事件，或在 V1 加入未知历史事件，同样拒绝；这些失败不生成新 successor，也不改动现有 generation 字节。实验没有把这些文件“修好”或降级。

## 验证边界

正常学习只需要运行已提交样本。若要了解压缩样本和发布版采集如何生成，继续读[复杂历史章节](RICH-HISTORY.md)；其中的生成脚本会重建本 Lab 的固定 fixture，与这里复制到临时目录进行 read/write 实验的操作不同。

2026-09-29 的基础 keyless 测试使用真实发布包、worker 和临时文件系统，覆盖两份非空 plaintext fixture 的 read/write/reopen、源 SHA-256、已有 V1+V3 generation 不变、future/corrupt/unsupported body 拒绝，以及新建 V4 的默认 Zstd header。两次 demo 都观察到逻辑版本 4、源 SHA-256 前后一致、read 阶段无 successor、write 后新增 V4、重新打开稳定。2026-10-01 的压缩历史和附件增量结果另见[复杂历史章节](RICH-HISTORY.md)。这些样本不能代表任意历史用户日志均可无损升级。

Session 格式版本属于 DSH 的持久日志。它与应用数据库 schema、业务 Run/Task 状态、模型会话恢复是不同问题：可读取历史 Session 不等于一次不确定的工具副作用可以安全重试，也不等于旧客户端可读取 V4。保留 predecessor 是审计与升级策略，不提供自动 fallback 或 downgrade。相关业务恢复实验见[可恢复 Agent 服务](../../projects/recoverable-agent-service/README.md)。

源码事实可从固定 revision 的 [JSONL backend 文档](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/README.md)、[V3→V4 发布测试](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/tests/v3-restart-migration.spec.ts)和[V1 历史读取测试](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/tests/jsonl.spec.ts)查证。
