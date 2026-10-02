# 工具结果裁剪与图片 offload 验收

日期：2026-09-30。基线 `eeb1df8`，扩展 [Compaction Lab](../../labs/compaction-lifecycle/REDUCTION.md)，固定 npm `0.1.7-rc.2` / Cordis `4.0.4` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。macOS arm64、Node `26.7.0`、pnpm `12.3.4`。

## 本批是什么证据

真实发行包的 AgentLoop、工具管线、pruner、image-offload 与 JSONL；模型响应和预算错误由 controlled adapter 产生。每个场景创建一份经过 CRC/zlib 检查的70字节1×1 RGBA PNG，引用它的真实 hash/尺寸，并单独核对操作后及关闭后文件未变。没有生产 AttachmentStore 或外部模型调用。

| 场景 | 对话 / 摘要请求 | prune / offload | 最终持久事件 |
| --- | --- | --- | ---: |
| 低压力 | 2 / 0 | 0 / 0 | 17 |
| 裁剪解除压力 | 2 / 0 | 1 / 0 | 20 |
| 裁剪后摘要失败 | 2 / 1 | 1 / 0 | 22 |
| 裁剪后摘要取消 | 1 / 1 | 1 / 0 | 18 |
| agent offload 恢复及下一轮换 route | 3 / 0 | 0 / 1 | 25 |
| retained images 耗尽 | 3 / 0 | 0 / 2 | 18 |
| 缺失 offload count | 1 / 0 | 0 / 0 | 12 |
| offload 后 manual summary 失败 | 1 / 2 | 0 / 1 | 15 |
| offload 后 manual summary 取消 | 1 / 1 | 0 / 1 | 15 |
| 裁剪保留既有 offload | 4 / 0 | 1 / 1 | 31 |

工具案例实际执行一次 fixture tool，裁剪不重执行工具。低压力保留长结果；正常裁剪只保留固定头尾与 marker；两个后续摘要失败/取消场景保留已提交的缩减。manual summary 案例中的 completed turn 是准备历史，不代表 maintenance 成功。

图片恢复按 occurrence 而非 attachment ID 选择；两个初始 occurrence 与新 occurrence 共用同一个 PNG。换到2M窗口的 fixture route 后，旧 index0 仍被省略，旧 index1和新 occurrence 保留。原始消息和图片文件都没有被 offload 改写。无 `llm/retry` 事件；不把 surface repair 当 transient provider retry。

## 运行发现与修正

- 初始组合 probe 在 idle 中直接调用 pruner，内存结果可用，但公开 backend 重开拒绝了 turn 外的 replacement tool/result。改为下一轮已开启 turn 的 pre-step 写入，再通过持久校验。
- 首次新增 profile 等待不到报告，根因是 fixture plugin 访问 sessions 却未显式声明该 injection。补齐依赖后启动验证通过；不能只凭 SDK initialize ready 判断课程 plugin 已完成。失败组3个采样 PID 已退出，状态保留，没有自动重放模型任务。
- 独立 review 构造了真实反例：把保留图片的 attachment.name 改掉，旧验收仍通过。补上“改名/移动非文本块”两个 RED/GREEN 负对照，要求完整字段和顺序；同时把请求次数、tool 执行次数及 serialized view 变为硬断言。
- PNG fixture 在进入最终 profile 验证前完成 CRC 和 zlib 校验；这验证的是测试输入，不替代生产附件归一化。

## 最终结果

| 检查 | 结果 |
| --- | --- |
| keyless tests | 29项通过：原17项、新10场景、2个 live pruner 变异负对照 |
| 独立 profile | 原10场景回归 + 新10场景全部通过 |
| persistence | 每个 profile 关闭后重开 V4，完整事件指纹一致；新场景还核对显式 image projection 的消息指纹 |
| 附件字节 | 70字节，SHA-256 `e6f217a3ddbdbfa0a558cc8e09f9f54004e8a9990409168efb2348c9abb97869`，操作前后和关闭后不变 |
| 进程采样 | 200ms；旧组13个、新组12个记录 PID，结束后均不存在；非完整进程审计 |
| typecheck / lint / format / build / frozen install | 通过 |
| 文档/链接/图表 | 10 篇变动 Markdown、121 个相对链接、4 个 Mermaid 图表通过 |
| 暂存 diff / credentials | diff 检查通过；18 个文件凭据模式与个人绝对路径命中均为0 |
| 独立复核 | rich-block P2 已修正，最终无剩余 P1/P2；请求与执行次数、projection 与 byte 校验均已明确 |

新增 runtime PID：`13511, 13514, 13516, 13519, 13567, 13569, 13572, 13574, 13578, 13580`。元数据见[结果 JSON](../../labs/compaction-lifecycle/evidence/2026-09-30-reduction.json)。失败目录按脚本保留；成功目录在 owner 关闭、日志和图片验证后删除。没有传入 API Key，外部模型请求为0。

## 限制

没有验证生产附件 store/上传、实际 provider 图片预算错误、视觉质量、路径授权、所有 nested rich content、并发变更、部分持久化失败、强杀恢复或所有平台。只读重放不等于 Agent 冷恢复。完整事件指纹保障与现场记录一致；独立的预期内容断言才保障现场行为没有遗漏或改写图片字段。
