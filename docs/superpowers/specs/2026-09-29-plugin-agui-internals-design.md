# Cordis、AG-UI 与机制笔记迁移

## 目标与版本

接续 `effa5f3`，完成剩余旧版 Cordis/plugin lab、AG-UI 毕业项目和七篇机制笔记的固定版本审查。使用 npm DSH `0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`，Cordis `4.0.4`。保留原 worktree，按此前授权提交完成增量，不推送。

## Cordis 与 preset

保留原创 Service/inject/effect/event/HMR 实验和 package `./tool`、`./listener` 子路径、`write_stage4_proof`、proof/audit/health 文件接口。升级公开 DSH tool/result、Agent/Session API 与依赖，删除失效包/旧 source launcher；runtime 集成通过公开 dsh profile 与 patch 运行。

补充一个最小公开 preset 示例或有执行证据的验证，说明 preset 是声明的 Agent composition 与作用域，不是 sandbox。只有模型工具 schema/description 需要变化时才修改它，并查 agent-experience 技能；本批不扩展 proof 工具功能。

通过 keyless lifecycle/tool/listener/preset 测试、build/typecheck/lint/format、packed plain-Node consumer，以及一次真实模型 tool call。文件字节、live/durable 对应 call ID 和关闭回收必须由外部状态验证，不能只看回复。

## AG-UI

保留 Fastify、React/CopilotKit、SQLite Conversation/Run/RunEvent/Artifact、business cursor SSE 与已有恢复/幂等语义。继续使用 SDK JSON-RPC 以保留原生事件观察；不在本批切换到 ACP。stock 新版 SDK 仍调用 agents.create，因此必须重新审查现有 deployment adapter，不能把它描述为 SDK 原生 resume。

改用同版本 npm dsh 的 `sdk-minimal` profile，通过有序 patch 加载编译后的应用 adapter、Cordis tool/listener、持久化与精简可见工具策略。禁止旧 package demo bin、完整私有 Cordis app 入口和 upstream source attestation。替换 `--runtime source` 为明确的 package 模式，更新所有消费者和命令；保留 fake 模式。

SDK 新版不下发 token delta：AG-UI text start/content/end 由已提交 assistant message 投影，不能把一次完整文本拆成伪实时输出。V4 tool/result 是新格式，projector、listener、fake fixture、artifact extraction 与 UI tests 同步更新。保留已有业务历史，不无故 bump SQLite schema 或抹掉旧事件。

runtime home/持久 Session 数据与 generation 临时目录分开；重启不能删持久历史。关闭失败隔离 owner，不在旧进程旁建新 generation。恢复按 session ID 和 canonical cwd 检查，通过当前 persistence.stat/header 与 agents.resume；实际 API 以固定 tag 为准。保留外部 artifact/audit 校验。

验收包括 keyless server/web、三 compiler faces、production build、foreign-cwd 启动 smoke、两个 Conversation 的真实工具与产物、同一 Session 跨 runtime generation 回读随机 nonce（不得从 prompt/工具文件泄漏答案）、AG-UI detach 后 business stream 到终态、desktop/375px 浏览器、错误与正常关闭进程观察。

## 七篇机制笔记

七篇正文与 README 改为固定新版 source facts：public profiles/preset、Agent/loop、V4 tool pipeline、immutable generation、compaction/context、subagent/workflow 与 SDK/ACP/Web Host 区别。逐条核对对应源码，不能仅替换 SHA。旧 2026-08-31 的 603 tests 留作历史，不能标为新版结果。

可以引用本仓库已实际执行的固定新版 probes，但必须直接支持该篇的具体结论；没有新 runtime 证据的内容显式标为 source-verified/未重跑，并提供最小可执行验证入口。不借用 master 的测试来声称固定 tag 通过。尽量用发布包运行独立 keyless probes；若需要源码测试，在独立临时快照中使用固定 tag，不改当前 upstream checkout。

## 分工与依赖

Cordis agent 只改 `labs/cordis-plugin-lifecycle/`，保持消费接口。AG-UI agent 只改 `projects/ag-ui-dsh-runtime/`，可先实现调用方，但等 Cordis 新版 build 稳定后再完成 file dependency 安装和联调。文档 agent 只改 `how-dsh-works/`，其验证脚本放该目录，不能改两个应用。协调者负责共享导航、验收记录和浏览器。
