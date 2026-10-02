# Compaction overflow 与取消

基线 `7fd2dc1`，继续现有 Lab，固定 `0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`。只读 upstream，按执行计划与 TDD 推进，最后独立复核；本地 commit，不 push。

1. [x] 用受控 adapter 驱动真实 AgentLoop/BasicCompactionEngine：thrown/in-band overflow 恢复、预算耗尽、预算0、非标准错误、不缩小/摘要失败、manual/overflow summary 取消，以及忽略取消信号的自动迟到摘要。
2. [x] 编译 fixture plugin，经公开 sdk-minimal profile 在独立进程跑同组案例，关闭后从公开 backend 重读 V4 并比较完整事件指纹和 surface。
3. [x] 教程说明同 step retry、durable replacement 前提、两个重试预算、取消优先和无 Key 故障注入范围。
4. [x] Lab 检查、链接/图表/凭据检查、独立复核并提交。

不向实际供应商构造百万 token 溢出；不把 controlled adapter 结果标作真实 provider overflow。既有真实 pressure 摘要实验保持独立。此轮不挂 pruner/image-offload，不推断它们取消后的状态。
