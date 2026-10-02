# 工具结果裁剪与图片 offload

基线 `eeb1df8`，固定 npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。继续已批准课程路线，只读 upstream，独立复核后本地 commit。

1. [x] 公开 pruner/offload + AgentLoop 的受控案例：低压力不裁剪、裁剪免摘要、摘要失败/取消保留裁剪、图片恢复/耗尽/缺失 count、summary 失败/取消保留 offload、裁剪保留既有图片选择。
2. [x] 验证图片按 occurrence 选择、route 变化不恢复旧 occurrence、新 occurrence 可保留、fixture PNG 字节未变。
3. [x] 独立 sdk-minimal profile 重跑，关闭后完整日志指纹及显式注册 projection 的消息重放；缺失 projection/坏索引负对照。
4. [x] 教程/机制章/路线/验收、测试与静态检查、链接/图表/凭据、独立复核与 commit。

不调用真实视觉供应商，不把 fixture 附件引用等同于生产 attachment store，也不把模型占位符视为原文件删除或读取权限隔离。
