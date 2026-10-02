# 复杂历史：压缩旧日志、发布版采集与附件引用

## 问题与版本

非空、压缩的 V1/V3 Session 能否通过发布版 backend 只读迁移为 V4 逻辑事件，随后发布不可变的 V4 successor？一个由发布版 backend 写出的非空 V4 Session 能否在全新 backend 中重读，并关联到发布版附件 store 保存的图像？这两个问题分别验证历史迁移与当前格式采集；V4 的新写入压缩不等于 V1/V3 迁移。

固定版本：`@deepseek-ai/dsh-session-persistence-jsonl`、`@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-attachment-local`、`@deepseek-ai/dsh-attachment` 均为 `0.1.7-rc.2`，Cordis `4.0.4`；上游 tag `dsh-v0.1.7-rc.2` 对应 commit [`477b4f420553e8a52c2fbccc464d7561b239c443`](https://github.com/deepseek-ai/deepseek-harness/commit/477b4f420553e8a52c2fbccc464d7561b239c443)。实验使用 Node 26.7.0、pnpm 12.3.4、macOS arm64；发行包锁定在本目录的 `pnpm-lock.yaml`。

## 样本来源

| 样本                                                 | 来源                                                                                                               | 物理编码与内容                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `synthetic-v1.jsonl.zstd`、`synthetic-v3.jsonl.zstd` | **手写合成历史**，由同目录 plaintext 样本转换；不是发布版录制，也不是个人 Session                                  | 官方固定版的两个独立、带 checksum 的 Zstandard frame：header 与非空 body；V1/V3 event schema 来自对应发行版          |
| `recorded-v4/`                                       | **由发布版记录**：`scripts/capture-release.ts` 调用公开的 `create`、`append`、`flush` 与本地附件 store `saveImage` | 六条 V4 event，包括一条 user image attachment 引用；发布版 backend 写出的 `session.v4.jsonl.zstd` 和图像对象一并保存 |

合成样本的压缩脚本使用 Node `zstdCompress` 和 `ZSTD_c_checksumFlag=1`，与固定版 [Zstandard frame 实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/src/zstd.ts) 的编码参数一致。它只编码样本，没有复制迁移器或实现 V1/V3→V4；迁移和 successor 均由发布版 JSONL backend 完成。`one-pixel.png` 是采集时的固定合成输入，`recorded-v4/metadata.json` 保存发布包、格式版本、事件数、相对文件名和 SHA-256。采集脚本没有调用模型。

## 复现与观察

从本目录运行：

```sh
cd labs/session-format-migration
pnpm install --frozen-lockfile
node --import tsx scripts/generate-compressed.ts
node --import tsx scripts/capture-release.ts
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

两个脚本只重建本 lab 的固定样本文件，运行用临时 root，并在结束后清理。`capture-release.ts` 会重建 `fixtures/recorded-v4/`，保留可重读的图像对象。历史测试将样本复制到各自新的临时 root：`open(id, "read")` 暴露 V4 逻辑事件，但只留下原 V1/V3 generation；`open(id, "write")` 新增压缩 V4 successor。压缩与 plaintext 迁移结果逐事件相等，并固定检查事件顺序、连续 seq、user/assistant 文本、V1/V3 embedded stream，以及 step/turn 结束事件；故意清空 user 文本或移除结束事件会让这些断言失败。原压缩字节和 SHA-256 前后相同，全新 backend 读到相同事件，V4 successor 字节在重开后也相同。测试还改变完整 frame 的 checksum 字节、加入一个真正带 `version: 5` 的带 checksum 压缩 header、破坏已发布 V4；这些输入拒绝读取和写入，V5 明确给出升级 harness 的错误，不回退到可读 predecessor，也不改动原文件。发布版采集测试在全新 backend 和附件 store 中读出六条事件，并按引用取回图像对象核对内容 digest。

本次固定样本 SHA-256：V1 压缩 `d881a991be26ea439d1886a6ecef8f25b1380cfa6416c299ce4b645f62f0a76d`；V3 压缩 `92b98c232d38a064333512ba7e1e101f4f8132f93988686eaa8d878c6d8af8d3`；发布版 V4 `c74df16205faa900da9f27283d0b0aff569c2e5022840cdc9f650b1b74541577`。V4 样本的图像对象 digest 和路径在 `metadata.json` 中。SHA 仅核对这些字节，不是所有历史格式的兼容性声明。

## 源码路径与结论边界

固定版 [JSONL backend](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/src/index.ts) 选择最高 generation；[historical preparation/publication](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/src/generation.ts) 解码、沿发布格式链迁移并校验 successor；[local attachment store](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/attachment/attachment-local/src/index.ts) 将图像对象与 Session 引用分开保存。实验观察与这些源码路径一致。旧 generation 保留供审计，不承诺 fallback、downgrade、混合编码读取或任意真实个人历史都能迁移。文件型图像对象可重读也不意味着丢失的业务工具副作用可安全重试。

本章只覆盖单 Session 的压缩历史与附件引用。`workflow-child-lifecycle` 的 child catalog / forest 集成由其所属章节验证：需要一个有 parent/child descriptor 的固定版样本，对 parent 执行 read/write/reopen，核对 catalog、child 关联及各 generation 的原字节；本 lab 的六条 V4 事件没有 child，不能算作该验收项。
