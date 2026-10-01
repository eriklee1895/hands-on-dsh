# 全章节完成 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for inline work and superpowers:subagent-driven-development for independent delegated chapters; retain existing completed evidence. User explicitly requests continuous execution through all chapters, local commits only.

**Goal:** 完成本仓库既有课程与路线中尚未完成的章节，将每章连接到可运行产物、版本、验收和明确的实验限制。

**Architecture:** 延续当前 worktree 与各 Lab 的独立依赖，不重启已经完成的课程。主线以 README 的 Phase 1–7 与 engineering 的未勾选项为范围；额外研究限制不能自动变成无限扩张的章节，也不能抹掉已有未完成承诺。

**Tech Stack:** Python SDK 0.1.5rc1；npm DSH 0.1.7-rc.2；Cordis 4.0.4；本机 macOS arm64 与可用 Linux container；各目录 lockfile。

**Spec:** [主路线](../../../README.md)、[工程化课程](../../learning-paths/engineering.md)，以及用户本轮“完成全部chapter、未完成前不必停下来”的明确目标。

## Global Constraints

- 基线77f3fdd，branch codex/refresh-curriculum-20260928，本地commit，不push。
- upstream只读，固定477b4f420553e8a52c2fbccc464d7561b239c443；各语言发布渠道不混用。
- 只操作本次自有fixture、workspace、进程、容器与确认创建的远端对象；不读个人Session充当样本。
- 已有DEEPSEEK凭据仅通过环境传递；其他服务缺必需配置时继续独立章节，记录阻塞后再请求所需信息。
- 区分源码核对、keyless真实发布包、故障注入、真实模型、真实外部系统，保留失败证据。
- 不通过降低断言、删除未完成项或将fixture错误描述成供应商故障来完成清单。

## Remaining Work

### Task 1: 核对全部目录与逐章证据，修正陈旧导航；建立最终验收索引

- [ ] 核对全部目录与逐章证据，修正陈旧导航；建立最终验收索引。文件：README、docs/learning-paths、docs/reviews/2026-10-01-chapter-audit.md。验收：所有现有章节可定位、既有未完成项有owner与后续证据。
### Task 2: 完成图片预算/offload与stale Files ID恢复章节

- [ ] 完成图片预算/offload与stale Files ID恢复章节。文件：labs/attachment-input。验收：真实发布provider的小预算拒绝、持久选择/重放、已选图片与文件字节、明确限定的stale-ID恢复；不制造账户超限。
### Task 3: 完成复杂历史存储章节

- [ ] 完成复杂历史存储章节。文件：labs/session-format-migration、workflow-child-lifecycle。验收：压缩非空历史、附件与child catalog样本、固定版本采集、不可变predecessor、fresh backend重读；不用个人历史。
### Task 4: 完成compaction持久化/并发失败与PTC/child恢复章节

- [ ] 完成compaction持久化/并发失败与PTC/child恢复章节。文件：labs/compaction-lifecycle、workflow-child-lifecycle。验收：可复现的失败与无错误成功声明；可区分正常关闭恢复与crash/森林恢复；工具外部状态核对。
### Task 5: 完成实时transport与Web控制收尾

- [ ] 完成实时transport与Web控制收尾。文件：labs/web-host-lifecycle、机制第07章。验收：将已验证的官方Web实时帧接入课程入口，补admission断线、等待中取消/迟到回答、重复投递与crash场景，不将SDK committed事件当token。
### Task 6: 完成容器workspace与远程执行章节

- [ ] 完成容器workspace与远程执行章节。文件：labs/sandbox-isolation。验收：自有Linux容器/受限挂载与远程执行路径、跨workspace拒绝/外部产物/清理；当前docker可用。
### Task 7: 完成跨引擎适配章节

- [ ] 完成跨引擎适配章节。文件：labs/protocol-semantics。验收：在既有显式能力接口上接入可用Codex/Hermes，真实binary与真实任务结果分开记录；失败/生命周期语义不伪装一致。
### Task 8: 完成三篇计划中的比较：DSH Session events与AG-UI、SSE与WebSocket、DSH/Codex/Hermes adapter

- [ ] 完成三篇计划中的比较：DSH Session events与AG-UI、SSE与WebSocket、DSH/Codex/Hermes adapter。文件：docs/comparisons。前两篇复用已有明确版本与运行证据，第三篇依赖跨引擎实跑；引用canonical实现，不复制教程。
### Task 9: 全课程收尾

- [ ] 全课程收尾。文件：全章索引及受影响README/路线。验收：相关测试、命令入口、所有文档相对链接、凭据扫描、独立review；每项有证据或明确尚未解决的阻塞，只有全目标满足才标记完成。

## Execution Rule

逐项先读现有代码和固定源码，确定最小可运行案例；行为修改先写失败测试，再实现并跑匹配检查。每个完成增量更新验收与本清单并本地commit，随后直接继续下一项。逐项细节及失败诊断保存在对应执行记录，不反复重跑已通过且不受后续改动影响的真实API案例。

## Review Focus

- “已完成”是否误用了旧版本、fixture或静态证据：每个结论注明版本与执行级别。
- 控制失败是否留下真实副作用：验证自有产物/对象/进程，保留执行不确定性。
- callback、cancel、crash的终态是否被统一接口压平：保留原始语义及能力声明。
- 迁移/重放是否改变旧记录：核对原始字节与独立重读。
- 剩余范围是否被暗中缩小：最终对照本清单和原始未完成项逐条核销。
