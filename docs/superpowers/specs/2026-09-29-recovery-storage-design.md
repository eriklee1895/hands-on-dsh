# 可恢复服务与 Session V4 迁移实验

## 目标

接续 `6bf3f63`，完成可恢复服务的 SDK 升级和历史 Session 格式实验。两者分别回答“业务怎样面对不确定执行”和“历史日志怎样进入新版读取/写入”。业务 SQLite schema、DSH Session format 和模型会话恢复不得混成一种版本或保证。

## 可恢复服务

`projects/recoverable-agent-service` 升到 Python SDK/runtime `0.1.5rc1`，固定源码 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`。公开 `sdk-minimal` / `dsh_home` 替代旧 session_root；同步更新配置名、调用方和 README，不保留未验证的兼容 launcher。

新事件投影输出 root `assistant_message` 的完整文本，替代新运行的 text_delta；数据库中已有 text_delta 事件仍按原 seq/type/data 重放，不重写或丢弃。SQLite schema 不因仅新增事件 type 而无谓升级。Run/RunEvent/Artifact 的权威仍在应用，runtime session ID 是引用。

保留幂等提交、同 Conversation 单活动 Run、持久游标 SSE、不可变 BLOB 产物与恢复确认语义。升级后的进程重启仍将旧 running 标记 execution_uncertain，不自动重放；acknowledge-recovery 旋转 session，不能声称 stock SDK 有跨进程 resume。线程执行的 startup/run/close 在等待方取消时仍保留所有权，回收未确认禁止复用。

验证用 keyless 旧数据库/重启/恢复确认与取消回归；真实 E2E 重新确认 completed、产物字节/hash、terminal SSE、重连游标与幂等响应，正常关闭外部检查进程。Python 3.10 floor 和 uv/Ruff 保持。

## Session 格式实验

新建 `labs/session-format-migration`，使用精确 npm `0.1.7-rc.2` 的公开 JSONL persistence package、Cordis Context 和 Session 类型。它是持久化库实验，直接挂载一个 backend，不启动 Agent 应用或私有 runtime bin；后续需要完整 Agent 时仍使用 dsh profile。

默认只复制项目内人工构造且标明来源/版本的 V1、V3 fixture 到新临时 root，禁止接收任意用户数据路径。使用固定版本公开 backend API 验证：

1. 非空历史消息经真实迁移链变成 V4 逻辑结果；V1 必须包含旧 stream/message 情况，不只改 header。
2. read open 不发布 successor、不改变源字节/文件清单。
3. write open 发布当前 V4 generation，源文件 SHA-256/字节及已有 generation 保持不变。
4. 新 backend 再次打开，逻辑结果和已生成 successor 不变；最高版本损坏不能回退到较老可读 generation。
5. 拒绝不支持的 future version/不可迁移内容，失败不发布 successor，不修改源文件。

保持迁移计算在官方包内，不复制上游 codec/repair 实现。fixture 路径布局若无公开 helper，按固定版本文档/源码在极小 helper 中明确，README 说明依赖的版本。优先展示 plaintext，若使用公开 API 可验证默认 Zstd 则一并覆盖；未覆盖的物理编码明确列出。

产物是可运行 demo、行为测试和中文解释。keyless 使用真实发布的 persistence backend/worker 和真实文件系统，不是 fake migration，也不等于读者任意历史 session 已可无损升级；不宣称降级支持、完整平台覆盖或模型业务恢复。

## 集成与提交

两目录独立实现；协调者更新学习路线、根 README、projects/labs 导航和第四批验收。沿用既有 worktree，完成独立 review 与验证后按已有授权提交本地 commit，不推送，不修改 upstream/个人会话。
