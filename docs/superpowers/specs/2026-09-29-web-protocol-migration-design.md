# FastAPI 与协议实验迁移

## 目标与基线

用户要求提交前两批后继续。已完成的 SDK 教程和 supervisor lab 提交为 `124802b`，本批继续在同一 worktree 工作。迁移 FastAPI 101 到 Python wheel `0.1.5rc1`，迁移 protocol-semantics 到 npm DSH `0.1.7-rc.2`。不修改 recoverable-agent-service、Cordis、AG-UI 或 upstream；它们的旧版本状态保留。

## FastAPI 方案

保留现有 lifespan / 同 session 串行 / 跨 session 并发、JSON API 和 POST SSE 页面。runtime 使用公开 `sdk-minimal` profile 和显式独立 DSH home。正文事件改为 `assistant_message`（root 已提交文本，替换当前回答），状态和工具事件仍逐事件到达；final 给出权威最终回复，不能重复拼接。页面、第二章和其他章节统一说明这不是逐 token streaming。

模型 error/max-tokens 不能被 UI 标为成功；SSE 在响应开始后以 error 事件终止。服务关闭停止接纳新工作、等待所有已接纳请求（包括 JSON 请求），失败初始化也要关闭已创建的 SDK owner。不要把 HTTP disconnect 当作 wire cancel。队列丢弃策略需要文档诚实说明，terminal 事件不得被普通迟到通知覆盖。

验证范围：keyless projection、失败终态、SSE 帧、同/跨 session、shutdown/startup failure、已提交文本替换；真实 JSON、多轮记忆、SSE、工具文件外部字节；浏览器桌面与窄屏，页面无错误且正文不重复。Python >=3.10、uv/Ruff 保持。

## Protocol lab 方案

沿用一个 JSONL peer，fake 模式仍完全 keyless。真实模式改为本项目锁定的 npm dsh，通过 `node <公开 dsh CLI> --profile sdk-minimal|acp` 启动。新增独立 npm manifest/lock 只为公开 runtime 分发，Python probe 不引入 SDK wrapper。删除旧 source-demo bin 路径及其 attestation 特例；显式 command 保留探索用途但不冒充固定版本验收。

固定 DSH `0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`；ACP JS SDK `1.4.0`，protocol v1；两种 wire identity 仍为 `0.0.1`，不等于产品版本。SDK 使用 root `assistant/message`，无 token delta 流和 resume RPC。

ACP 要求 fake 覆盖已公布的 list/resume/close 与配置选择，以及旧 cancel/permission/双向 request-ID 行为。list 只返回 inactive 可恢复 root；resume 校验 cwd，不回放历史 update；session/load 仍未实现。真实实验至少完成 prompt + close/list/resume，复用持久 home 与相同 cwd；如可行，再跨 server 进程重启通过模型回读随机 nonce。配置选择以 advertised options 为准，不伪造 config ID。

所有 live run 使用 disposable workspace/HOME/DSH_HOME 和明示 credential allowlist；记录 closeOutcome 与实际进程组状态。fake transcript、源码事实、真实 prompt、真实恢复分别报告，失败保持证据，不改为私有 launcher 或任意 master。

## 集成

FastAPI 和协议目录并行迁移，协调者拥有 root/learning paths/comparisons 和验收记录。Browser 验证由协调者完成。新改动通过 review 后保留可审查状态；本批不推送。
