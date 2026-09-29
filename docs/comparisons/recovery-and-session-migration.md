# 业务恢复、会话恢复与格式迁移

三种操作处理不同的问题。一次操作成功，不能作为另两种操作已完成的证据。

| 操作 | 权威数据 | 做什么 | 不保证什么 |
| --- | --- | --- | --- |
| 业务恢复 | 应用 SQLite 的 Conversation / Run / RunEvent / Artifact | 重启后处理旧 running，要求显式确认不确定执行，保留幂等键、事件和产物 | 不知道外部工具副作用是否完成，不能自动重跑 |
| 模型会话恢复 | DSH 持久 Session 与当前 runtime | 如新版 ACP resume，将既有历史恢复到 Agent，后续输入可使用上下文 | 不回放旧 UI updates，不恢复应用业务 Run 状态 |
| Session 格式迁移 | DSH 历史 generation 与当前 codec | 将旧物理记录翻译成当前逻辑事件；写打开时生成当前 generation | 不执行旧任务，不保证降级读取，不判断业务是否成功 |

## 可恢复服务的重启

[Recoverable Agent Service](../../projects/recoverable-agent-service/README.md) 把 Run 状态存在 SQLite。服务重启后，旧 running 被归档为 execution_uncertain，对应 Conversation 需要确认；acknowledge-recovery 使它重新 active 并旋转 DSH session ID。旧 Run 的 session 快照、事件、幂等键和不可变产物仍保留。

这个确认操作允许提交新的工作，不会重放旧 prompt。调用方要先核对外部状态，再决定下一条任务；同一个幂等键也不能借恢复确认绕过原来的请求指纹。

新 runtime 的正文投影使用 assistant_message。旧数据库中的 text_delta 仍是当时记录的事实，按原 seq/type/data 重放；不能在读取时把每个旧增量改名成完整消息。业务数据库 schema 与 DSH Session writer 是两个独立版本，必须按实际字段和兼容要求分别管理。

## ACP 的持久会话恢复

`0.1.7-rc.2` 的 ACP 可以 list、resume、close 持久 root session。resume 需要会话 inactive，cwd 与持久 header 一致；它恢复上下文但不重发旧消息/工具 updates。客户端自己的历史展示仍需单独存储。SDK JSON-RPC 没有同等 resume 方法。

[协议实验](../../labs/protocol-semantics/README.md)通过两个实际 server 进程、相同 home/workspace/session 和不使用工具的 nonce 回读验证这一点。它验证的是固定版本内的恢复，不等于旧日志向新格式迁移。更换协议也不能直接替代旧 AG-UI 项目的适配与浏览器验收。

## 历史 generation 的读取与发布

固定 `0.1.7-rc.2` 的 JSONL backend 选择最高 canonical generation。历史文件以 read 打开时，backend 执行迁移、验证当前逻辑结果，但不发布 successor；以 write 打开时，backend 构造并验证当前 generation 的临时文件，复核源版本后以不覆盖方式发布。既有 predecessor 的字节保持不变。迁移链按相邻版本转换，但一次写打开发布的是当前 generation；不代表每个中间版本都要落盘成文件。

不要把“返回的 header.version 已经为 4”误认为“磁盘上已存在 V4 文件”。实验同时核对逻辑消息、源字节/hash 和目录中的 generation 文件。已有最高 generation 损坏时，应报告错误，不能偷偷回退到较老记录。

[Session 格式迁移 lab](../../labs/session-format-migration/README.md)只使用项目内 synthetic fixture 的临时副本，通过发布的 persistence backend 验证上述操作。它不读取个人会话，也不证明任意真实历史数据都能无损迁移。跨版本工具事件、子会话 catalog、附件与物理压缩编码应按需要增加独立样例。

固定源码：[JSONL backend](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-persistence-jsonl/README.md)、[format catalog](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/session/session-format-catalog/README.md)、[ACP Session](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/acp/acp/src/session.ts)。本批实际验证和局限见[第四批记录](../reviews/2026-09-29-recovery-storage.md)。
