# 复杂历史存储章节验收记录

执行窗口：2026-10-01 深夜至 2026-10-02 凌晨，Asia/Shanghai。工作树基线 `77f3fddceb5d8fe9cb7ccb5137c2a89f1329f6b4`；同一共享工作树中的其他目录改动不属于本记录。环境为 macOS arm64、Node 26.7.0、pnpm 12.3.4。源码真源为 `dsh-v0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`，实验安装发布包 `0.1.7-rc.2`。

## 实际完成

- 新增[复杂历史章节](../../labs/session-format-migration/RICH-HISTORY.md)与两份**手写合成**压缩 V1/V3 fixture。输入是原有非空 plaintext fixture，`scripts/generate-compressed.ts` 用固定版采用的 checksum Zstd 双 frame 编码；没有自写格式迁移器。压缩 V1 SHA-256 为 `d881a991be26ea439d1886a6ecef8f25b1380cfa6416c299ce4b645f62f0a76d`，V3 为 `92b98c232d38a064333512ba7e1e101f4f8132f93988686eaa8d878c6d8af8d3`。
- `scripts/capture-release.ts` 用发布版 `@deepseek-ai/dsh-session-persistence-jsonl` 的公开 `create/append/flush` 和 `@deepseek-ai/dsh-attachment-local` 的 `saveImage` 写出独立 V4 样本。事件内容是实验控制的六条手工输入；**Session 压缩字节和图像对象由发布版存储实现写出**，不把它表述成模型或完整 Agent 运行。全新 backend 与附件 store 重开后，六条事件及图像引用可读。两次重录的 V4 SHA-256 均为 `c74df16205faa900da9f27283d0b0aff569c2e5022840cdc9f650b1b74541577`，对象 digest 见 `fixtures/recorded-v4/metadata.json`。
- 压缩 V1/V3 在只读打开后与各自 plaintext 迁移逐事件相等；固定检查 user/assistant 文本、V1/V3 embedded stream、完整事件顺序、连续 seq 和 step/turn 结束事件。故意清空 user 文本或移除结束事件的负对照使语义断言失败。目录在 read 后仍仅有 predecessor，原二进制字节不变；write 后新增 V4 successor，重挂载后事件和 successor 字节稳定。变更完整 frame 的末尾 checksum、放入带真实 `version: 5` 压缩 header 的 V5 generation、损坏最高 V4 时，读写均拒绝且不回退或改写低 generation；V5 报错要求升级 harness。

## 命令与结果

在 `labs/session-format-migration` 中执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 完成；随后新增发布版附件依赖并更新本 lab lockfile |
| `node --import tsx scripts/generate-compressed.ts` | 完成，生成两份压缩合成历史 |
| `node --import tsx scripts/capture-release.ts` | 完成；重录两次，输出相同 log/object digest |
| `pnpm test` | 3 个文件、16 个测试通过；真实发布版 backend/worker 与临时文件系统 |
| `pnpm typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm format:check` | 通过；章节初稿曾未通过，已格式化并重跑 |
| `git diff --check` | 通过 |

keyless 结果只证明固定版在这些受控样本上的行为，不覆盖个人历史、模型 API、混合编码、跨版本后退或线上升级。测试每次使用临时 root，结束后清理；没有读取用户 Session 或凭据。

## 剩余集成门槛

`workflow-child-lifecycle` 不在本任务文件所有权内。该章节仍需固定版 parent/child descriptor 样本，验证 parent 的历史 read/write/reopen 补全 child catalog、forest 关联，以及 parent/child predecessor 字节保留。这里的 V4 附件样本没有 child，因此不能据此宣布整个复杂历史/child catalog 任务完成。

独立review发现并修正两处P2：原压缩测试只看assistant存在，现检查完整语义并加入丢文本/终态的负对照；原future样本只改文件名，现写入真实V5压缩header并核对升级错误。修正后独立复核运行压缩8项通过，无剩余P1/P2。
