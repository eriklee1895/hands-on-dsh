# Web 取消、审批与离线重连

继续既有 Web Host Lab，基线 `fc67f56`，固定 npm `0.1.7-rc.2` 与 upstream `477b4f420553e8a52c2fbccc464d7561b239c443`，只读 upstream。

1. [x] 核对公开 cancel、approval audit 和 disconnect 语义，扩展 keyless 证据验证器与负对照。
2. [x] 官方 Web profile + 独立 home/workspace：拒绝、单次允许、工具执行中取消、浏览器离线后恢复；不自动重放任何 prompt。
3. [x] 关闭 Host 后用公开 backend 核对终态、审批关联、工具调用数量、marker/产物/未发生的副作用及 PID 观察。
4. [x] 编写控制案例教程与验收，更新能力表；针对性检查、独立复核、本地 commit。

范围限制：不承诺 exactly-once delivery 或通用回滚。已发生的副作用不会因 cancel 自动撤销；离线实验若 Host 继续执行，浏览器断线不能写成取消。拒绝工具可以与 completed 根 turn 同时成立。所有文件与命令限定在实验目录。
