# 复杂历史：压缩旧日志、发布版采集与附件引用

## 问题与版本

上一课可以直接打开 plaintext 日志逐行阅读。文件改为 Zstandard 压缩后，我们还能验证同一套 read/write 行为吗？这里先比较压缩与 plaintext 旧日志的迁移结果，再检查一份由当前发布版 backend 写出的 V4 日志及其附件。

这两组样本回答不同的问题：V1/V3 检查历史格式迁移，当前 V4 检查发布版写出与重读。即使新写入的 V4 压缩文件完全正常，也不能据此说旧日志已经能够迁移。

固定版本：`@deepseek-ai/dsh-session-persistence-jsonl`、`@deepseek-ai/dsh-session-persistence`、`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-attachment-local`、`@deepseek-ai/dsh-attachment` 均为 `0.1.7-rc.2`，Cordis `4.0.4`；上游 tag `dsh-v0.1.7-rc.2` 对应 commit [`477b4f420553e8a52c2fbccc464d7561b239c443`](https://github.com/deepseek-ai/deepseek-harness/commit/477b4f420553e8a52c2fbccc464d7561b239c443)。实验使用 Node 26.7.0、pnpm 12.3.4、macOS arm64；发行包锁定在本目录的 `pnpm-lock.yaml`。

## 样本来源

| 样本                                                 | 来源                                                                                                               | 物理编码与内容                                                                                                       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `synthetic-v1.jsonl.zstd`、`synthetic-v3.jsonl.zstd` | **手写合成历史**，由同目录 plaintext 样本转换；不是发布版录制，也不是个人 Session                                  | 官方固定版的两个独立、带 checksum 的 Zstandard frame：header 与非空 body；V1/V3 event schema 来自对应发行版          |
| `recorded-v4/`                                       | **由发布版记录**：`scripts/capture-release.ts` 调用公开的 `create`、`append`、`flush` 与本地附件 store `saveImage` | 六条 V4 event，包括一条 user image attachment 引用；发布版 backend 写出的 `session.v4.jsonl.zstd` 和图像对象一并保存 |

合成样本的压缩脚本使用 Node `zstdCompress` 和 `ZSTD_c_checksumFlag=1`，与固定版 [Zstandard frame 实现](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/src/zstd.ts) 的编码参数一致。它只编码样本，没有复制迁移器或实现 V1/V3→V4；迁移和 successor 均由发布版 JSONL backend 完成。`one-pixel.png` 是采集时的固定合成输入，`recorded-v4/metadata.json` 保存发布包、格式版本、事件数、相对文件名和 SHA-256。采集脚本没有调用模型。

## 复现与观察

从仓库根目录运行已提交样本的检查：

```sh
cd labs/session-format-migration
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

先看历史测试。每份样本都复制到独立临时 root：`open(id, "read")` 暴露 V4 逻辑事件，磁盘只保留原 V1/V3 generation；`open(id, "write")` 则新增压缩 V4 successor。这个顺序与上一课相同。

“能读出来”还不够。测试要求压缩与 plaintext 的迁移结果逐事件相等，检查事件顺序、连续 seq、user/assistant 文本、embedded stream 和 step/turn 结束事件。故意清空 user 文本或移除结束事件时，断言必须失败。原压缩字节及 SHA-256 始终不变；新 backend 读到相同事件，V4 successor 重开后的字节也相同。

再看拒绝路径。测试分别修改完整 frame 的 checksum、放入真正带 `version: 5` 的有效 checksum 压缩 header，以及破坏已发布 V4。这些输入都拒绝 read/write；V5 明确要求升级 harness，不回退到可读 predecessor，也不改写原文件。三种拒绝分别检查损坏检测、未来版本识别和最高 generation 的选择，不能只用一个随意损坏的文件代替。

最后看当前 V4 采集。全新的 backend 读出六条事件，再由附件 store 按消息引用取回图像对象，比较内容 digest。Session 日志和图像对象是两份存储，日志读出成功并不自动证明附件还在。

## 可选：重建固定样本

只有在研究样本的生成方式时才需要这一步。仍在本 Lab 目录执行：

```sh
node --import tsx scripts/generate-compressed.ts
node --import tsx scripts/capture-release.ts
```

第一个脚本从固定 plaintext 输入重写两个 `.zstd` fixture；第二个在临时 root 中调用发布版 backend 和附件 store，再重建 `fixtures/recorded-v4/`。采集的临时 root 在结束后清理，固定样本里的图像对象保留供后续重读。两条命令都会重建仓库内的样本文件，不是普通只读检查。

本次固定样本 SHA-256：V1 压缩 `d881a991be26ea439d1886a6ecef8f25b1380cfa6416c299ce4b645f62f0a76d`；V3 压缩 `92b98c232d38a064333512ba7e1e101f4f8132f93988686eaa8d878c6d8af8d3`；发布版 V4 `c74df16205faa900da9f27283d0b0aff569c2e5022840cdc9f650b1b74541577`。V4 样本的图像对象 digest 和路径在 `metadata.json` 中。SHA 仅核对这些字节，不是所有历史格式的兼容性声明。

## 源码路径与结论边界

固定版 [JSONL backend](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/src/index.ts) 选择最高 generation；[historical preparation/publication](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/src/generation.ts) 解码、沿发布格式链迁移并校验 successor；[local attachment store](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/attachment/attachment-local/src/index.ts) 将图像对象与 Session 引用分开保存。实验观察与这些源码路径一致。旧 generation 保留供审计，不承诺 fallback、downgrade、混合编码读取或任意真实个人历史都能迁移。文件型图像对象可重读也不意味着丢失的业务工具副作用可安全重试。

本章只覆盖单 Session 的压缩历史与附件引用。`workflow-child-lifecycle` 的 child catalog / forest 集成由其所属章节验证：需要一个有 parent/child descriptor 的固定版样本，对 parent 执行 read/write/reopen，核对 catalog、child 关联及各 generation 的原字节；本 lab 的六条 V4 事件没有 child，不能算作该验收项。
