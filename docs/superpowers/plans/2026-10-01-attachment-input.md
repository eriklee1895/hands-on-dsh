# 附件存储与真实图片输入

基线 `e679d6d`，固定 npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。继续既有课程路线，本地 commit，不 push。

1. [x] 公开 LocalAttachmentStore：接纳/去重、缩小归一化、输入拒绝、cache 重建、收紧写限制后读旧对象、损坏拒绝。
2. [x] 使用 SDK encoded image 输入，两张独立随机四象限色块图；答案只在父校验进程内，禁止工具读取，真实模型返回结构化颜色顺序。
3. [x] 本地受限测试代理观测 Messages/Files 图片传输；拒绝账户级清理，只清理本次确认创建的上传，不记录 Key 或原始请求体。
4. [x] 关闭 runtime 后独立 store/backend 重读 normalized 对象和 Session，验证引用/字节/模型结果；文档、检查、独立复核后 commit。

不测试个人图片、不制造真实供应商超限、不承诺跨机器存储或物理掉电耐久。Files 与 inline 分别按实际观察记账，不能由模型答对推断其中一个成功。

结果见[验收记录](../../reviews/2026-10-01-attachment-input.md)：15项 keyless tests；一次真实运行、2个 Messages 响应、2个 Files 上传及删除、22个持久事件；第二轮仅为历史/传输复用证据。
