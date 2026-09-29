# Phase 7.4：文件写入限制与执行隔离的实测

复用固定npm SDK/runtime0.1.7rc2，新增独立sandbox-isolation lab。以macOS当前宿主为实测平台，明确Linux/Windows只做固定源码对照，容器/远程executor不冒充完成。目标是区分workspace路径、文件写入策略、读取/网络/进程能力，以及真实工具是否经过该策略。

以发布包LocalSandboxProvider.confine精确argv和真实子进程执行三模式矩阵（danger-full-access为显式未包裹对照，非失败fallback）。每模式使用新fixture：HOME下独占随机root包含workspace和outside，另在系统temp创建独占目录。避免把outside放进Seatbelt默认允许的temp。只使用自己的canary、文件、父PID和环回HTTP服务，不扫描任何用户资料/外网。

worker JSON结果：inside write、outside read/write、symlink write到outside、descendant write到outside、独立temp write、loopback request、signal0检查父进程可见性。期望macOS只读所有写入拒绝，workspace-write仅inside/temp允许，其他写入拒绝；两者outside read、loopback、父进程可见仍允许。未限制模式所有允许。拒绝仅允许EPERM/EACCES/EROFS；不存在路径、程序启动失败等是探针错误而非安全通过。父进程验证每个目标实际字节或缺失，不信模型/worker自报。

源码与示例都公开说明enforcement full只针对文件效果词汇。要求未限制对照先成功；confine/runner失败中止，不能退回未包裹argv或标记通过。只允许macOS执行这份固定期望矩阵，其他平台明确退出而非静默跳过。

真实模型集成：公开sdk-minimal+patch sandbox-policy mode，独立home/workspace，shell工具运行同一个built worker argv；检查真实tool/call和匹配tool/result、根turn/end、结果JSON与外部文件事实。两种受限模式，启动120s/activity180s，失败不自动重试。工具命令不得请求更宽mode或escalation；调用与结果检查避免把宿主直接运行当作工具证据。模型报告不是判断依据。

父级SDK/runtime和自写插件仍是受信任宿主代码，不由下游命令的sandbox保护。provider探针不启动DSH app；模型例通过公开profile启动。所有临时文件仅自己创建，确认进程结束和SDKclose成功才删除；失败保留目录，清理有界，不杀无关进程。

实施分工：父agent拥有package/toolchain、fixtures/probe orchestration、model example、docs；独立agent拥有worker.ts及worker行为tests；独立review检查拒绝归因、side effects与清理。固定发行源码只读，不改upstream。
