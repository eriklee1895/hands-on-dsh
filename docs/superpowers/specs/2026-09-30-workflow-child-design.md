# Workflow PTC 与 child 冷恢复实验设计

在现有已批准课程路线内新增一个固定 `0.1.7-rc.2` 的 Lab。workflow 使用公开 PTC engine 顺序调用两个一次性 child 写入/复核临时文件；continuable child 在首个 runtime 记住随机口令，整个 runtime 关闭后由第二个 runtime 恢复相同父 Session，再通过公共 `sendMessage()` 冷恢复 child 写出该口令。只在可丢弃 workspace 执行固定任务。

真实程序使用 `sdk-minimal` profile 加编译后的课程 plugin。plugin 通过公开 service 驱动实验，父 Agent 的 pre-step 被显式拒绝以避免 settlement 通知额外调用模型；不是 SDK 原生 session resume，也不宣称模型生成 workflow 脚本或 tool-workflow durable 记录已验证。相同的实验函数由无 Key 组件测试覆盖，模型 adapter 可受控，PTC 进程和 JSONL persistence 使用真实发行包。

成功需要 completed outcome、精确文件字节、实际工具调用、child identity/descriptor/catalog 和历史前缀一致。冷恢复第二次配置和消息都不带口令；关闭后用独立 persistence backend 检查日志。失败不重放，未确认关闭或验证失败时保留临时目录，只输出白名单元数据。超时触发取消并等待 provider 清理，不宣称硬性总 deadline。

不覆盖进程崩溃恢复、复杂并行/retry、全森林恢复、外部 subagent provider、恶意脚本隔离、网络封禁、SDK 原生冷恢复。普通 workflow failure 与 cancel/late-start disposal 使用无 Key 控制案例。
