# Phase 7.6：可恢复服务的确定性评测

基线46bf702，复用projects/recoverable-agent-service及其PythonSDK/runtime0.1.5rc1，不新增工具链或SaaS。目标是用固定input/expected/metadata评测应用失败语义与可重放报告；不是模型通用质量benchmark，也不把期望输出直接作为实际输出。

五个场景：success（精确artifact）、tool-error（可控工具失败但turn completed且artifact缺失）、aborted-turn（注入已结算aborted，不伪造cancel RPC）、transport-disconnect（RuntimeAdapter抛ExecutionUncertainError，attention_required）、recovery（在SQLite预置running，startup恢复不自动重跑，ack旋转session，显式新Run成功且历史Run不变）。每场景都检查幂等重复提交与终态SSE游标重放。这里的resume是业务恢复或事件游标重放，不是stockSDK冷恢复。

数据集文件eval/cases.json的schema_version=1，dataset_id为安全slug，dataset_version正整数，sdk_version固定0.1.5rc1。cases非空，id唯一安全slug，scenario为上述五项；input字段只含prompt/artifact_name/artifact_content（均为公开虚构素材），expected字段只含固定的下列17项，metadata只含description/evidence（controlled-service-contract）。所有字段必需，未知字段/重复JSONkey/无效枚举、bool冒充数字、重复case/空集均拒绝。

Observation与expected同结构：runtime_finish(null|completed|aborted|error|max-tokens|refusal)，必须取实际adapter结果或抛错后的null；state(succeeded|failed)、error_code(null|agent_outcome|execution_uncertain)、conversation_state(active|attention_required)、artifact_state(available|missing|invalid)、artifact_sha256(null|64hex)、artifact_bytes(null|非负int)、artifact_download_status(200|404)、artifact_metadata_matches(bool)、tool_errors(非负int)、runtime_calls(非负int)、terminal_event(run.succeeded|run.failed)、replay_exact(bool)、idempotent_replay(bool)、recovery_rotated(bool|null)、prior_run_preserved(bool|null)、cleanup_confirmed(bool)。非recovery的两个恢复字段为null；recovery为true。所有检查必须精确通过，不以总体平均值抵消失败。

eval_contract.py公开：load_dataset(path)->Dataset，parse_dataset(value)->Dataset，EvalCase含id/scenario/input/expected/metadata，Dataset含dataset_id/dataset_version/sdk_version/cases。grade_case(case, observation:object)->dict输出case_id/passed/checks（字段名->bool）/failed_checks；不回显任意失败值。build_report(dataset, results:list[dict], mode:str)->dict验证非空、重复、case归属与mode，报告selected与not_run及每例checks/counts，不称完整模型质量。mode仅controlled-service或real-provider。真实模式只能success场景。

eval_scenarios.py公开run_case(case:EvalCase, root:Path, real:bool=False)->dict。实际SQLite、coordinator、应用HTTP/SSE/artifact代码工作；controlled adapter按scenario和input产生行为，不读expected。真实分支仅success，DSHRuntimeAdapter实际写proof。CLI通过eval_process.py为每例启动自有POSIX进程组，15s/240s默认deadline，超时有限TERM/KILL回收后退出2并保留状态，不能声称业务取消或撤销副作用。用TestClient完整lifespan，不宣称网络TCP断线实测。生成的Observation来自真实存储/HTTP字节与runtime调用计数，cleanup_confirmed在close成功之后设置，runtime_calls/runtime_finish及幂等seq在drain后重新采集，避免迟到工作漏评。超时/close失败保留状态并抛安全错误；runtime不确定请求不重试。

examples/evaluate.py支持默认完整controlled suite、--case选择、--real只跑success、--record写安全报告数据（观测记录不含prompt/response/token）、--replay读记录重新评分、--negative-control对实际观察的单一字段做故意变异并返回1。严格record schema及dataset fingerprint避免换fixture后无声通过，case集合与mode记录完整。父进程传递其已加载dataset的SHA-256，每个子进程加载后比较再执行，拒绝运行途中改动的数据集；record replay不执行runtime。成功exit0，检查失败exit1，配置/记录/基础设施错误exit2；不自动改expected或录制“新golden”。

测试必须证明grader能抓到坏行为：改变状态、重复runtime_calls、artifact哈希或SSE replay等会失败；缺字段/错误类型不会获通过。默认评测5案例通过、negative-control确实非零、保存重载报告一致，再显式真实success1例。原171项目回归保持；原真实e2e仍单独deselect。最终review分别审查runner不从expected造actual、评分/报告不漏案例、failure语义与清理。
