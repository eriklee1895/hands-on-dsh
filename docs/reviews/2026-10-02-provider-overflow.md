# 服务端context overflow验收

2026-10-02，npm0.1.7-rc.2 / upstream477b4f420553e8a52c2fbccc464d7561b239c443，Node26.7.0/pnpm12.3.4、macOS arm64。[章节](../../labs/compaction-lifecycle/PROVIDER-OVERFLOW.md)使用一次有界长输入，工具关闭、maxTokens16、重试0、本地catalog4M，不加载compaction。

输入prompt为2,200,104字节（不含完整HTTP请求封装），代理透传而未注入错误；唯一一次远端Messages返回400，DSH终态error/code `CONTEXT_WINDOW_EXCEEDED`，正文为空、0tools。12个V4事件与现场记录相同，长输入hash核对，临时目录清理，exit0。导出[元数据](../../labs/compaction-lifecycle/evidence/2026-10-02-provider-overflow.json)，没有原始长prompt、Session或Key。

新增验收负对照拒绝本地-only错误、其他400错误码、成功响应、额外请求和工具执行；证据保存失败的负对照先见listener未关，再用finally保护使其通过。该清理保护在真实请求之后补入，只执行了本地验证，没有重发长请求。

Lab测试增加到32项，类型/lint通过；最终32项测试、类型/lint/format/build、frozen install均通过；独立review无P1/P2，输入字节与HTTP封装的表述已区分。本课实际证明服务端错误分类与持久终态；真实摘要自动恢复没有在此重跑，不与受控adapter恢复结果混算。
