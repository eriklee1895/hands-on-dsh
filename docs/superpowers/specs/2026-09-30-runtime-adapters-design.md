# Phase7.7：能力明确的协议适配

基线5ed5e9d，复用labs/protocol-semantics及其公开npm DSH0.1.7rc2、stdlib JSONL peer、SdkProbe/AcpProbe与OwnedState。不重写transport，不新增依赖。两个实现都是engine=dsh，分别sdk-jsonrpc/acp；Codex/Hermes仅登记not-integrated，不据此断言其产品能力。

adapters.py提供 describe_adapter(engine,protocol)->dict以及open_adapter(protocol,server)->async Adapter。server只fake/package（不接无版本command）。Adapter共有prompt(text,timeout=None)->AdapterResult，close()->安全关闭摘要；Result含engine/protocol/status(completed|settled|cancelled|incomplete)、text(str|null)、session_id、settlement、native(有限字段)、tool_events(int)。SDK只有receipt匹配、root completed且rootidle才completed；ACP按stopReason=end_turn映射settled，cancelled保留，max_tokens为incomplete，禁止把end_turn冒充rootcompleted，保留原始语义。不得将连接关闭或本地waiter取消映射native cancelled。SDK probe补root tool/call数量，实际模型验证要求两协议均0工具。

能力表区分supported/unsupported/probe-only/not-integrated。共有prompt/process_close为supported；session_close/resume为ACP supported、SDK unsupported；cancel为ACP probe-only（本课仅封装现有确定性cancel fixture）、SDK unsupported；token_stream两者unsupported。permission仅明确ACP probe-only，本课默认reject-once，未支持普通生产审批UI。

扩展方法close_session()/resume()只ACP，保持同session和cwd、resume不重放历史文本；cancel_probe()只ACP+fake，包装现有AcpProbe.cancel_prompt，不作为任意prompt的生产cancel。unsupported在发送RPC前抛UnsupportedCapability；package cancel_probe明确拒绝，不制造live支持证据。未知engine/未集成Codex/Hermes在启动任何进程或创建目录前拒绝。

每个Adapter独占owner，一个prompt同时运行，busy立即拒绝；未开始/关闭/故障后的调用明确拒绝。prompt超时/EOF/RPC失败保守AdapterExecutionError带有限kind及may_have_executed=true，不重试；faulted后须close不能继续prompt。本地取消waiter也faulted并原样传播CancelledError。close与活动prompt不并发拆owner，应等活动结算（等待本身原probe有界）；多个close caller共享shielded cleanup，close后独立group检查通过才删除OwnedState，未知回收保留路径。

comparison.py CLI默认--server fake跑共同正常prompt、timeout、EOF/JSONRPC错误、新状态禁止复用，以及SDK拒绝扩展、ACP确定性cancel与close/resume。输出每case checks/expected类别及证据层，known失败不自动当成功；负对照--negative-control故意改首例exactMatch检查并exit1。--server package仅运行两协议同一随机nonce prompt，两者精确回复、协议正常结算、工具0、正常关闭且groupgone；故障/cancel/resume本次未live运行写not_run，旧跨进程ACPresume证据仅链接，不冒充本批。return0全部selectedchecks通过、1检查失败、2基础设施/配置错误。输出不包含key、prompt或provider错误文本。

独立review检查结果映射、unsupported不发wire、并发busy/close/取消ownership、未确认退出禁止删目录。源码事实与fake/liveness/真实模型分开；本课完成DSH双协议适配基础，不宣称Codex/Hermes已接入。
