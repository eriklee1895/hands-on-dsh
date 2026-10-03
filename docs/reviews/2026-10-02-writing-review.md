# 全章节写作、技术与可视化审查

审查基线：PR #2 合并后的 `main`，`dc26b577416e4d393f687530894f8ca9a82f6b4f`。本报告审查该版本的课程质量；没有将最新 upstream 的变化混入既有版本，也没有改写章节、提交或发布本报告。

后续落实与本轮新验证见[写作修订记录](2026-10-02-writing-revision.md)。以下问题和行号保留初审基线，不能作为修订后的未完成清单。

## 整体判断

这套材料已经形成了可信的工程实验库，距离流畅的系统教程还差一轮编辑。最有价值的部分是：每个重要结论都有版本、源码或运行依据，失败结果也被保留。读者能学到不确定执行不能自动重放、业务 Run 与模型 Session 各自负责什么，以及为什么模型回复不能代替外部文件验证。

目前的主要问题是，这些证据经常直接占据正文的组织结构。许多章节先说明做过哪些检查，再介绍读者要解决的问题；源码路径、字段和未覆盖项又集中出现。对作者而言这是完整的交接，对第一次接触系统的读者而言却少了中间的推导。应保留技术严谨性，把正文改成“遇到问题 → 跑一个小例子 → 看见差异 → 解释原因 → 改一处再试”的连续讲解。

审查发现了需要先修的事实与操作问题，见下文。未发现需要推翻整套课程架构或主要实验结论的 P1 问题；这不代表所有运行行为均在本轮重新验证。最值得优先编辑的部分是 Python 入门指令、FastAPI 阅读入口、TypeScript 四例、Cordis、AG-UI，以及七篇机制章。

## 范围与本轮证据

逐文档审阅 75 个学习相关 Markdown 文件，包含正文、双语镜像、入口、学习路线、比较文章和一篇明确标记的历史附录；另读 TypeScript 四个示例及相关实现、测试和验收记录。75 是文件数，不是独立课程数。逐篇记录在报告后半部分。其余计划、设计和验收记录作为查证材料，不作为面向初学者的正文要求改写。

本轮实际执行：

- 核对本地 `main`、`origin/main` 和 GitHub PR #2 的 merge commit 一致。
- 全部 138 个已跟踪 Markdown 的 680 个相对文件链接存在；7 个本地 Markdown 锚点经标题匹配检查未发现问题；193 处固定 SHA 的 DSH 源码链接在本地对应 Git 对象中存在。此检查不等于外网可达性检查。
- 核对 Python `dsh-v0.1.5-rc.1` 为 `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`，npm `dsh-v0.1.7-rc.2` 为 `477b4f420553e8a52c2fbccc464d7561b239c443`。用固定 revision 检查 SDK 创建/恢复、请求与工具流水线、协议、迁移、压缩与 Web 接纳等关键结论。
- 用当前 FastAPI 源码、Fake runtime 和现有依赖运行 TestClient：第一章 Markdown 路由返回 HTTP 200、`text/markdown; charset=utf-8`，正文仍含字面 Mermaid 代码块，没有 HTML 渲染。未调用模型。
- 运行当前协议实现的无模型比较：`PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/labs/protocol-semantics/src" python3 -m protocol_labs.comparison`，13/13 通过，全部 `group_closed/state_removed=true`。这不等于重验 uv 安装或真实 provider。
- 在独立本地浏览器画廊用 Mermaid 11.16.0 渲染全部 44 张现有图，44/44 成功；测量所有图，抽查代表图在 1200px 和 375px 视口的实际可读性。没有用本地样式结果冒充 GitHub 或 FastAPI 正式页面的截图。
- 查看全部四张现有图片：三张官方 Web 实验截图和一张 FastAPI 概念插画。截图适合定位页面观察，但仍需日志与文件证据解释；插画没有组件文字标签，不能承担精确架构说明。

本轮没有安装新依赖、重新调用付费模型、运行 Docker 实验或重跑完整测试套件。文档中原有的真实运行和测试成绩仍属于各自日期；本报告的技术核对是源码、实现、已有证据与上述少量新检查的结合。

## 先修正的事实与操作问题

### F1 · P2：Python 第二章误把同 ID 复用写成持久会话恢复

[中文第二章](../../tutorials/python-sdk/tutorials/02-reuse-session.zh.md)第 11 行和[英文第二章](../../tutorials/python-sdk/tutorials/02-reuse-session.md)第 11 行都说，保留 home 后复用 ID 会恢复持久对话。这与锁定版本的 [SDK server](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/packages/sdk/server/src/server.ts#L259-L290)不符：进程内已有 handle 才复用，首次遇到 ID 则调用 `agents.create()`，并不自动调用 `resume()`。章节第 49 行又说跨进程恢复未验证，形成页内矛盾。

应明确：示例验证同一个存活进程内的两轮复用；保留 home 便于检查日志，不意味着 stock SDK 自动恢复历史。重复运行使用新 ID。跨进程恢复另指向明确实现了恢复入口的章节。

### F2 · P2：Python 十二篇章节没有沿用首页的凭据加载方式

[Python 中文入口](../../tutorials/python-sdk/README.zh.md)第 13–22、38–43 行让读者将凭据放在仓库根 `.env`，运行时显式使用 `--env-file ../../.env`；六章中英文的运行命令全部只有 `uv run python ...`。前一次 `uv run --env-file` 不会替之后的 shell 命令设置环境。脚本没有自动加载 dotenv，因此只按首页创建 `.env` 的读者无法顺着章节直接运行。

统一每章的起始目录和 `.env` 命令；已有导出环境变量的用法可以作为另一种选择。现有 `tests/test_demos.py` 对 README 的检查没有覆盖十二篇章节，这解释了为什么测试通过仍留下学习入口断点。

### F3 · P2：FastAPI 的主要阅读入口没有渲染章节和 Mermaid

[前端入口](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/index.html)第 46 行及 [app.js](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/app.js)第 62 行直接链接 `/static/tutorials/*.md`；[app.py](../../tutorials/fastapi-101/src/dsh_fastapi_101/app.py)第 101 行用 StaticFiles 原样提供文件。本轮 Fake/TestClient 检查确认原始 Markdown 响应；浏览器具体显示原文还是下载由客户端决定，但服务没有提供图文渲染。

五篇章节已经有六张 Mermaid。优先让现有章节可读：提供本地 Markdown/Mermaid 阅读页面，或明确跳到能渲染的文档入口。无需为这一问题先引入完整文档平台。

### F4 · P2：Web 恢复课的执行顺序不闭合

[Web RECOVERY](../../labs/web-host-lifecycle/RECOVERY.md)第 39 行要求停止 Host 后做持久验证，第 43 行立即要求在浏览器创建新 Session，没有重启步骤。后续总验收又需要同一实验 root 中的多个 Session。应给出复用同一 root 的重启、等待 ready 和刷新步骤，或把最终停机验证移到相应实验末尾。

同页第 52–68 行要求先跳到第三节做 admission，再回第二节执行 concurrent，顺读时又会遇到第三节“先运行”。[探针脚本](../../labs/web-host-lifecycle/examples/browser-recovery-probes.js)第 12–16 行明确拒绝同 mode/session 重跑。应按实际操作顺序排列，避免读者重复提交或误删保护标记。

### F5 · P2：两处图示的时序或执行主体不准确

[Python 第五章](../../tutorials/python-sdk/tutorials/05-low-level-client.zh.md)第 36–39 行先画 inbox receipt、再画 RPC response，之后才标“Owned activity interval starts”；英文同样如此。正文和实现将匹配 receipt 作为活动下界，而且刻意支持 response 迟到。应将开始标记放在 receipt 处，说明 response 用于关联，响应前的事件已经被订阅缓冲。

[Compaction 基础实验](../../labs/compaction-lifecycle/README.md)第 78–79 行画成 `E→L` 执行任务、`L→Session log` 执行 Bash 写文件。LLM 产生工具调用，AgentLoop/工具执行器执行命令，文件和日志是两份不同证据。省略执行器使这张图恰好混淆了本章想强调的职责，应补 AgentLoop/工具和 filesystem，或拆成摘要过程与产物验证两张小图。

### F6 · P2：跨引擎共同接口缺少生命周期差异说明

[ADAPTERS](../../labs/protocol-semantics/ADAPTERS.md)第 3 行将四种入口纳入共同 `prompt/close` 接口；第 66–74 行泛称 Adapter，并说明 close 等待自有操作结算。前面第 2 节实际限定的是 DSH 双入口，后加入的 CLI 部分没有把这种限定重新讲清楚。

[DSH Adapter](../../labs/protocol-semantics/src/protocol_labs/adapters.py)第 303–318 行先等在途操作；[CliAdapter](../../labs/protocol-semantics/src/protocol_labs/cli_adapter.py)第 203–204、349、375–395 行则是每实例一次 prompt，成功后 `finished`，close 对仍存在的进程组发送信号并回收。这里是文档范围歧义，不是要求把两套正确实现强行统一。

增加生命周期表：每实例可提交几次、成功后是否可复用、活动期 close 做什么、是否提供 native cancel。将现有第 4 节明确限定为 DSH。

### F7 · P2/P3：导航、比较和机制章残留过期的当前状态

以下是当前页面之间的矛盾，应修当前说明或补正确链接；不要改写有明确日期的历史验收成绩。

| 位置 | 残留内容 | 当前依据与修改方向 |
| --- | --- | --- |
| [SDK/ACP 比较](../comparisons/sdk-jsonrpc-vs-acp.md)，43 行 | “旧 AG-UI 项目固定 0.1.1-rc.2” | 当前项目 manifest 为 0.1.7-rc.2；应描述当前 deployment adapter，历史背景另放迁移记录 |
| [Python/TS 比较](../comparisons/python-vs-typescript-sdk.md)，45、51 行 | FastAPI/AG-UI“后续迁移”，旧 adapter 仍固定原版本 | 当前已迁移；保留“SDK 不具备实时帧/原生 resume”的准确结论，更新项目状态 |
| [学习路径入口](../learning-paths/README.md)，13 行 | 容器、跨引擎及恢复扩展仍继续验收 | 全章节索引已完成所列范围，改为准确入口 |
| [机制第四章](../../how-dsh-works/04-session-event-log-and-projection.md)，69 行 | 压缩历史与 child catalog 样例仍列 Proposal | rich-history 和 workflow RECOVERY 已有限定样例；链接已完成内容，保留任意真实历史未覆盖的限制 |
| [机制第六章](../../how-dsh-works/06-subagent-and-workflow.md)，72 行 | PTC failure、catalog、并行/retry、forest 仍列后续 | 进阶课已补特定场景；不能继续让读者以为材料缺失，也不能把限定实验扩大成任意故障恢复 |
| [Compaction RECOVERY](../../labs/compaction-lifecycle/RECOVERY.md)，21 行 | `pnpm test 当前共29项` | 当前套件静态清点为 36；本页只维护“本章10场景”，总数归单一验收入口 |

### F8 · P3：五处起始目录说明与命令矛盾

以下页面说“从本目录”，第一条命令却是 `cd labs/...`：

- [Cordis](../../labs/cordis-plugin-lifecycle/README.md)，11–14 行。
- [协议实验](../../labs/protocol-semantics/README.md)，11–14 行。
- [Session 迁移](../../labs/session-format-migration/README.md)，11–14 行。
- [复杂历史](../../labs/session-format-migration/RICH-HISTORY.md)，20–23 行。
- [Workflow 恢复](../../labs/workflow-child-lifecycle/RECOVERY.md)，7–10 行。

统一为“从仓库根目录开始”，或在续课去掉重复 cd。[AG-UI README](../../projects/ag-ui-dsh-runtime/README.md)第 39–46 行另需说明 `server:fake` 和 `dev:web` 分别运行于两个终端；前者是常驻服务。

### F9 · P3：个别术语和验收语句需要收窄

[租户课](../../projects/recoverable-agent-service/TENANCY.md)第 45 行的“32–256 位 URL-safe ASCII”应为“32–256 个字符”，对应正则的字符长度。还应补实验结束时停止 server、等待自有 runtime 清理，以及本次生成的明文凭据文件如何保留/删除的步骤；不应提供无条件清空整个数据目录的命令。

[FastAPI 工具轨迹](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/04-tool-trajectory.md)第 56 行把浏览器不出现 API 凭据作为验收要求，但投影会转发工具 arguments/result，未实现通用脱敏。当前固定例子可以检查没有暴露请求头；正文应明确这不是任意工具输出都安全的保证。没有发现或声称真实凭据曾泄漏。

## 如何让正文像工程师在讲解

### 从读者眼前的现象进入

Python 第四章、进程池 A/B/C/D 例子、租户 alpha/beta 例子和 sandbox 的反直觉观察，已经具备好的叙述起点，应保留这种写法。它们让读者先看见差异，再有理由学习抽象。

最需要调整的是七篇机制章：目前几乎统一以版本、`Verified from source`、源码路径表开场。路径表适合查证，但读者尚不知道为什么要看这些文件。每章先选一个贯穿问题，例如“为什么 inject 后 Agent 仍是 idle”“日志中存在的消息为什么没有发给模型”“浏览器断开以后文件为什么还在变化”。随后沿实际调用追踪，最后再提供源码入口表。

### 一段完成一层解释

[Web RECOVERY](../../labs/web-host-lifecycle/RECOVERY.md)第 39 行同时讲迟到回答、随机 ID 对照、两种回执、哈希关联、34 个事件、源码和未验证 UI 操作。[Cordis](../../labs/cordis-plugin-lifecycle/README.md)第 28 行同时讲 Service、inject、PENDING、effect、timer/watcher/fd、waterfall 与 HMR。这种密度使读者无法判断当前该记住哪个因果关系。

把它们拆成连续的观察与解释，不必机械增加小标题。术语第一次出现时紧贴例子解释：surface 是“当前派生给模型的消息顺序”，checkpoint 是“用来替换一段旧消息的摘要记录”，admission 在具体段落中说清是接纳一次输入还是允许一轮工作开始。英文标识保留原名，正文用中文解释其职责。

### 给代码补上阅读任务和结果样例

TypeScript 四例只有一份 70 行 README，核心逻辑又分散到 helper；这更接近示例索引。每例应展示一小段核心调用、一个脱敏输出样例、一个可做的小改动，以及对应 helper 的阅读入口。Python 和 FastAPI 也应明确定位为“运行现成应用并逐步拆解”，或补齐真正从空项目构建的步骤，避免标题承诺超出材料。

运行命令之后，先解释读者刚刚看到什么，再列完整测试。针对复杂实验，固定给出“运行前状态、操作、应观察的字段、结果不同如何判断、收尾”；不必把格式变成每章重复的十项清单。

### 将查证材料保留在合适位置

版本、真实负面结果和必要限制要留在正文可见处。测试总数、当时修过哪些断言、某次 RED/GREEN、完整哈希和历史迁移过程则归验收记录。当前首页 305 行中，大量篇幅重复章节完成状态与 Phase 清单；将首页收敛为读者能做什么、选哪条路线、如何开始，完整进度由全章导航和验收索引拥有。

安全与不确定性也可以解释得自然：先展示“客户端超时但外部文件已经存在”的现象，再说明为何不能自动重发。这样读者理解了限制的原因，就不需要在连续数段里反复读同一个“不能”。

### 两段改写示意

以下是叙述方向示例，未修改原章。

**Python 会话复用**

> 第一轮，让 Agent 记住一串代号；第二轮，只问它刚才的代号是什么。第二条输入没有带答案，所以可以用来检查前一轮的上下文是否仍在。两次调用使用同一个 Session，也共享同一个 runtime 进程。
>
> 现在先别关闭程序。这个例子验证的是进程内复用：退出后，即使磁盘上的日志还在，当前 stock SDK 也不会仅凭相同 ID 自动恢复那段历史。后面的恢复实验会分别检查日志、恢复入口和业务状态。

**Compaction 的失败结果**

> 调用 `compactNow()` 抛错时，先检查 checkpoint 是否已经写出。错误可能发生在写入之后，只是调用方没有收到确认。`flush-after` 场景就停在这个位置：独立 reader 已经读到 checkpoint，flush 的包装函数随后才抛错。
>
> 因此，这一节同时记录三件事：surface 是否改变、重新打开日志能读到什么、调用方最终拿到了什么结果。把它们放在一起，才能决定下一步，而不是看到异常就再压缩一次。

## 图表：先修可读性，再补能解释关系的图

现有 44 张 Mermaid 全部能在本地 Mermaid 11.16.0 渲染；语法可渲染不代表语义准确或排版可读。14 张图的原始宽度大于 1200px。代表图宽度约为：机制 Workflow 1980px、进程池 1878px、可恢复服务 2058px、附件输入 1778px。前三张压进 920px 正文后标签明显缩小；在 375px 视口，整体自适应缩放基本失去阅读价值。

以下截图来自本轮独立审图画廊，保留原图源码，使用普通正文宽度；它们是排版诊断，不是正式产品页面。

[桌面宽度对照](assets/2026-10-02-writing-review/desktop-diagrams.png) · [375px 对照](assets/2026-10-02-writing-review/mobile-diagrams.png)

优先把长横图按职责分组，改为纵向布局或拆成两张图，缩短节点文字。保留可放大的独立 SVG 或横向滚动只是补充；正文默认状态仍应可读。中文课程的图中可保留 API 名，关系说明尽量用中文。

| 优先级 | 位置 | 图表要回答的问题 | 建议形式 |
| --- | --- | --- | --- |
| 先修 | FastAPI 五章 | 读者在哪里看到已有图？ | 修本地渲染入口，不先增加图 |
| 先修 | Python 05、compaction 基础 | 活动从哪个事件开始？谁真正执行工具？ | 改正确时序与参与者，见 F5 |
| 先修 | Workflow、Pool、Recoverable 等长图 | 读者能否在正文宽度下读清节点？ | 拆分/纵向/分组，避免长链整体缩小 |
| 高 | Session 与 compaction | 日志全部保留，模型为什么只看到一部分？ | 同一组 seq 的 log/surface/messages 三行前后对照；特别展示 replacement 后 seq 不再按数值排序 |
| 高 | Python/TS 低层客户端与协议课 | receipt、response、已提交文本、idle 各发生在何时？ | SDK/ACP 对称时序；标 response 可晚于 receipt，区分原生结束信号 |
| 高 | Recoverable 与 AG-UI | 重启时哪些对象消失，哪些保留？ack 会重跑吗？ | Run/Conversation 状态图；SQLite/DSH home 与 runtime generation 的分层图 |
| 高 | Web RECOVERY | 相同 requestId 为什么能串行去重，却并发接纳两次？ | 两请求泳道：各自检查未存在 → await admission → 各自插入；另示串行命中，不能暗示所有网络重试都重复执行 |
| 高 | Compaction TRANSACTIONS | 调用失败时，内存/磁盘/确认分别处于什么状态？ | start、summary、replacement、flush、end、throw 的分轨时间轴，标四个故障点 |
| 高 | Cordis 生命周期 | provider 消失后，consumer 和 listener 怎么变化？ | PENDING/ACTIVE 与 effect 创建/cleanup 时序，用现有五条 observations 串起 |
| 高 | 可观测性 | 哪个 usage 应计一次，为什么重放后金额不变？ | 小型事件账本与手算表，优于新增抽象框图 |
| 中 | 图片预算与 offload | 同一个附件为什么有的出现位置被替换、有的仍保留？ | hash→多个 `(seq,index)` 的映射，offload 只指一个 occurrence |
| 中 | Files fallback 与 stale | 上传失败和旧 ID 失效为什么采用不同恢复路径？ | 两张图 A/B 的前后请求对照，区别整请求 inline 与一次 stale 重传 |
| 中 | child forest | catalog、descriptor 和活跃 registry 各在哪里？ | parent→child→grandchild 对象图，区分持久记录与当前激活 |

不建议普遍增加装饰插画、没有测量依据的性能曲线，或再建一个交互式可视化站点。协议字段映射、能力矩阵、usage 演算用表更清楚；已经清楚的 STALE 六步观察和单次 provider overflow 不必为了统一样式强行加图。

现有 Web 截图可加简短图注，明确让读者看原 Session、回复内容和轮次统计中的哪一处；离线恐龙页只能证明浏览器当时离线，不能单独证明后台任务继续执行。FastAPI 概念插画可保留为封面，但其异步桥、runtime、模型与工具需要正文中的标注图解释。

可观测性最值得补的是一个具体算例。现有 fixture 两次 attempt 分别使用 `input/output/cache-read = 10/2/5` 和 `20/4/8`；教学费率下 `(10+20)×1000 + (2+4)×2000 + (5+8)×100 = 43300`。表中应说明为何选最终 usage、为何 scalar 与 embedded 不相加、为何重复导入也不增加。这个数只解释该 fixture 的显式教学费率，不是供应商账单。

## 逐章审查记录

以下“核对”均指静态审阅、固定版本与已提交证据的对照，除明确注明的新检查外，不代表重新实跑。表中无独立缺陷的章节仍有内容与图示建议。

### 首页、路线、机制与比较

| 文档 | 内容、文笔与技术观察 | 建议动作与图示 |
| --- | --- | --- |
| [README.md](../../README.md) | 课程覆盖与版本清楚，但完成清单、历史验收和快速开始叠成305行；读者入口偏晚 | 保留定位与快速开始；完整状态下沉到导航/验收；可加小型学习路线图，不放全能力图 |
| [docs/README.md](../../docs/README.md) | 跨主题组织职责清楚；上游审查链接应与当前学习入口分层 | 先链接全章导航与比较；迁移审查作查证入口 |
| [tutorials/README.md](../../tutorials/README.md) | 三类课程索引准确，简短有效 | 保留；不为索引加装饰图 |
| [projects/README.md](../../projects/README.md) | 两个完整应用及业务状态职责准确 | 保留；统一给读者一句完成后可做的事 |
| [labs/README.md](../../labs/README.md) | Lab范围明确；列表混入多个增量补课与验收状态 | 按问题分组并链接系列顺序；不再维护细测试数量 |
| [docs/learning-paths/README.md](../../docs/learning-paths/README.md) | 三条路径清楚；容器/跨引擎“继续验收”过期 | 修F7；路线入口只管选择，不复制完成账本 |
| [docs/learning-paths/chapters.md](../../docs/learning-paths/chapters.md) | 当前最完整的导航；长表压缩了很多中英术语 | 每个阶段补一句读者能回答的问题；保留顺序及版本区别 |
| [docs/learning-paths/python-app-builder.md](../../docs/learning-paths/python-app-builder.md) | 当前路线被大段8月历史验收打断，第三阶段出现较晚 | 旧版本细节移历史记录并留链接；连续讲SDK→Web→持久业务服务 |
| [docs/learning-paths/typescript-runtime-builder.md](../../docs/learning-paths/typescript-runtime-builder.md) | 六阶段清楚，但“本批/第五批/前四批”要求读者理解开发历史 | 改为当前学习目标、前置和产出；保留adapter非stock能力限定 |
| [docs/learning-paths/engineering.md](../../docs/learning-paths/engineering.md) | 工程课依赖与完成条件完整，但接近项目进度表 | 前半按学习问题串起七课；后半迁移清单归审计；保持费用/隔离限制 |
| [how-dsh-works/README.md](../../how-dsh-works/README.md) | 固定revision与证据分类严谨，入口大表过密 | 减少运行数量重复；读者先选问题，再查证据矩阵 |
| [how-dsh-works/01-plugin-tree-and-runtime-assembly.md](../../how-dsh-works/01-plugin-tree-and-runtime-assembly.md) | profile/preset/fiber划分与patch顺序准确；概念前无具体配置例子 | 从一个profile加载到两个工具的例子讲起；给patch覆盖前后小表及preset作用域分组图 |
| [how-dsh-works/02-agent-inbox-and-loop.md](../../how-dsh-works/02-agent-inbox-and-loop.md) | inject不唤醒、receipt-to-idle及维护等待的区别有源码依据 | 用同一条inject+followup贯穿；首次解释scope/initiator；图上区分status idle与whenIdle完成 |
| [how-dsh-works/03-turn-step-tool-pipeline.md](../../how-dsh-works/03-turn-step-tool-pipeline.md) | V4 toolCallId、准备请求和按模型顺序提交正确；主图只画成功链 | 增加无工具直接结束/失败重试分支或注明主图为工具路径；用两工具先后完成例子解释顺序 |
| [how-dsh-works/04-session-event-log-and-projection.md](../../how-dsh-works/04-session-event-log-and-projection.md) | surface seq非下标是关键而目前只一句；尾部Proposal过期 | 修F7；补log/surface/messages具体数字前后图；read/write图标清历史版本前提 |
| [how-dsh-works/05-compaction-and-context-assembly.md](../../how-dsh-works/05-compaction-and-context-assembly.md) | 机制较密；正文后半主要按测试从7到17到29到36的批次展开 | 按pressure→选区→摘要→replacement→失败组织；批次成绩移验收；补局部提交时间轴 |
| [how-dsh-works/06-subagent-and-workflow.md](../../how-dsh-works/06-subagent-and-workflow.md) | one-shot/continuable/catalog/PTC分工有依据；尾部仍列已补实验 | 修F7；先介绍父、一次性child、可续child；拆1980px横图并加持久对象图 |
| [how-dsh-works/07-sdk-jsonrpc-acp-and-web-host.md](../../how-dsh-works/07-sdk-jsonrpc-acp-and-web-host.md) | 三入口能力和实时/持久区别清楚；三种协议密集堆叠 | 先沿一条输入在三入口的去向对比；能力表保留；对称画出提交、输出、结算 |
| [how-dsh-works/historical-2026-08-31.md](../../how-dsh-works/historical-2026-08-31.md) | 明确隔离旧603项结果，没有把旧证据冒充新版 | 作为历史附录保留；不按新正文文风重写事实，避免抹掉日期语境 |
| [docs/comparisons/README.md](../../docs/comparisons/README.md) | 横向比较导航完整，重复空行略松散 | 统一列表排版即可；不需要图 |
| [docs/comparisons/python-vs-typescript-sdk.md](../../docs/comparisons/python-vs-typescript-sdk.md) | env继承差异、V3/V4与provider协议差异重要且有固定来源；项目状态残留旧信息 | 修F7；用一个env例子解释差异；保留矩阵而非做语言性能比较 |
| [docs/comparisons/sdk-jsonrpc-vs-acp.md](../../docs/comparisons/sdk-jsonrpc-vs-acp.md) | 方法方向与原生终态区分准确，AG-UI版本描述过期 | 修F7；把end_turn非completed的说明前移到能力/结果表附近 |
| [docs/comparisons/recovery-and-session-migration.md](../../docs/comparisons/recovery-and-session-migration.md) | 三种恢复分开是全课程主线；现有样例扩展在末尾仍以将来时出现 | 用一次重启串起三层，各自回答什么；链接已完成的rich-history/forest；一张分层图足够 |
| [docs/comparisons/session-events-vs-ag-ui.md](../../docs/comparisons/session-events-vs-ag-ui.md) | root投影、三套ID和committed内容准确；字段表有效 | 保留映射表；展示一条raw到RunEvent到AG-UI的短样例；缩短1302px横图 |
| [docs/comparisons/sse-vs-websocket.md](../../docs/comparisons/sse-vs-websocket.md) | 以本仓库两条链路比较，避免虚构性能胜负，范围合适 | 补HTTP上行与两类下行的并列图；用断开时刻说明订阅解除与任务取消不同 |
| [docs/comparisons/dsh-codex-hermes.md](../../docs/comparisons/dsh-codex-hermes.md) | 明确只比较适配层，不冒充产品全能力；终态与进程退出双判断合理 | 加入one-shot/reuse/close差异；将长tirith故障处理段落归适配课，比较页保留结论 |

### SDK、FastAPI 与完整应用

| 文件 | 内容与叙述评估 | 技术核对与行动 | 图示建议 |
|---|---|---|---|
| [tutorials/python-sdk/README.zh.md](../../tutorials/python-sdk/README.zh.md) | 路线与证据完整；先讲“Python应用需要Agent完成什么”再列API层级 | 版本0.1.5rc1匹配；修各章env入口一致性 | 可选一张Python→SDK→dsh进程总览，避免再画章节重复流程 |
| [tutorials/python-sdk/README.md](../../tutorials/python-sdk/README.md) | 双语事实基本对齐；术语密度同中文 | 同上 | 同上 |
| [tutorials/python-sdk/tutorials/01-hello.zh.md](../../tutorials/python-sdk/tutorials/01-hello.zh.md) | “生产式SDK生命周期/活动区间”抢在最小体验前；补5行最小调用与一段真实输出样式 | 修env；不要把模型逐次返回固定措辞写成必然 | 保留生命周期时序，最初只突出启动/运行/关闭 |
| [tutorials/python-sdk/tutorials/01-hello.md](../../tutorials/python-sdk/tutorials/01-hello.md) | “production-shaped”对初学者收益小；用运行后能检查的三件事切入 | 同中文 | 同中文 |
| [tutorials/python-sdk/tutorials/02-reuse-session.zh.md](../../tutorials/python-sdk/tutorials/02-reuse-session.zh.md) | 代号回忆是好教学动作；补“另一个ID有什么变化”的对照 | 修错误resume断言及env | 当前时序保留；增加一runtime包两session的微型所有权图比更多箭头有用 |
| [tutorials/python-sdk/tutorials/02-reuse-session.md](../../tutorials/python-sdk/tutorials/02-reuse-session.md) | 同中文，完整读过不是仅依赖对照 | 同上 | 同上 |
| [tutorials/python-sdk/tutorials/03-stream-events.zh.md](../../tutorials/python-sdk/tutorials/03-stream-events.zh.md) | committed≠token说清楚；删除“为保持链接保留文件名”的维护历史 | 根过滤/最后committed与final一致符合实现；修env | 现图仅展示if过滤，优先换成message commit→callback→idle→RunResult时间轴 |
| [tutorials/python-sdk/tutorials/03-stream-events.md](../../tutorials/python-sdk/tutorials/03-stream-events.md) | 同中文；加能看到何时打印的终端样例 | 同上 | 同上 |
| [tutorials/python-sdk/tutorials/04-workspace-agent.zh.md](../../tutorials/python-sdk/tutorials/04-workspace-agent.zh.md) | 本组最佳开场：模型说完成还不够，读文件验字节 | cwd非sandbox、sdk完整profile、精确文件验证成立；修env | 保留外部状态时序，不需要装饰图片 |
| [tutorials/python-sdk/tutorials/04-workspace-agent.md](../../tutorials/python-sdk/tutorials/04-workspace-agent.md) | 英文与中文目标、限制对应 | 同上 | 同上 |
| [tutorials/python-sdk/tutorials/05-low-level-client.zh.md](../../tutorials/python-sdk/tutorials/05-low-level-client.zh.md) | 一句塞入初始化/订阅/关联/投影/结算；拆成“入队回执为何不等于答案”再看三阶段 | method集合/receipt-to-idle核对；修env | 修活动开始位置；图上区分request id与messageId |
| [tutorials/python-sdk/tutorials/05-low-level-client.md](../../tutorials/python-sdk/tutorials/05-low-level-client.md) | 同中文 | 同上 | 同上 |
| [tutorials/python-sdk/tutorials/06-raw-jsonrpc.zh.md](../../tutorials/python-sdk/tutorials/06-raw-jsonrpc.zh.md) | 适用边界准确；“SDK创作”改“SDK实现”；列一问“为什么stdout/stderr都要持续读” | framing/并发排空/deadline/关闭可在实现定位；修env | 现流程可留，最好加一对真实JSONL帧来说明id关联，无需新大图 |
| [tutorials/python-sdk/tutorials/06-raw-jsonrpc.md](../../tutorials/python-sdk/tutorials/06-raw-jsonrpc.md) | 完整但像检查表；加一个刻意延迟响应的思考题 | 同上 | 同上 |
| [tutorials/fastapi-101/README.md](../../tutorials/fastapi-101/README.md) | “从零构建”实际是运行现成demo；选择明确为“从运行到拆解”，或补逐步实现任务 | 0.1.5rc1、sdk-minimal、错误HTTP/SSE语义匹配 | 总览保留，Queue应由callback入队、SSE出队的箭头更精确；生成插画只是装饰 |
| [tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/01-blocking-api.md](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/01-blocking-api.md) | 48行回答“为什么不能直接调用”很好；标题应解释阻塞的是请求等待而非事件循环 | to_thread、502、lifespan匹配；明确“项目根目录”指fastapi-101目录 | 现线程时序保留，给响应JSON短样例 |
| [tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/02-sse-stream.md](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/02-sse-stream.md) | 错误必须error帧的因果解释好；补一条真实SSE帧 | queue满丢普通事件保留terminal匹配；无token明确 | 在现图加线程/事件循环分区；error与final互斥分支比新图更有用 |
| [tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/03-multi-turn-session.md](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/03-multi-turn-session.md) | 正反对照练习有效；澄清业务ID=demo映射不是生产ID设计 | 一个runtime+多锁、进程内目录非持久目录成立 | 当前拓扑保留，可将runtime画成容器包住A/B更直观 |
| [tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/04-tool-trajectory.md](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/04-tool-trajectory.md) | 字段路径很密，先展示bash动作与对应两个事件对象 | V3 tool-result位置匹配；脱敏措辞需限缩 | 加一张Raw DSH→BrowserEvent字段映射表；无需再加一张泛流程图 |
| [tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/05-runtime-lifecycle.md](../../tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/05-runtime-lifecycle.md) | 最适合工程师讲故障故事：刷新页面后任务还在，关服务该等谁 | 锁/to_thread/任务追踪与关闭匹配；生产多worker局限准确 | 两图保留；补客户端断开后worker继续、shutdown等worker的泳道 |
| [tutorials/typescript-sdk/README.md](../../tutorials/typescript-sdk/README.md) | 一页包含4课、版本、失败、验收，压缩过度；每节增加观察样例与一次小改动练习 | 0.1.7-rc.2与JSON-RPC语义匹配；默认模型实际deepseek-flash建议写出（src/runtime-launch.ts:21-22） | 目前0图，优先receipt时间轴、runtime/session所有权图 |
| [tutorials/typescript-sdk/examples/01_explicit_launch.ts](../../tutorials/typescript-sdk/examples/01_explicit_launch.ts) | 51行里核心run仅数行，helper遮住教学主线；README展示核心摘录并链接完整健壮例 | completed检查、finally close后cleanup匹配 | 无需在源码加图 |
| [tutorials/typescript-sdk/examples/02_reuse_session.ts](../../tutorials/typescript-sdk/examples/02_reuse_session.ts) | 58行，nonce精确比较是有效练习；README说明第二轮为什么不能包含nonce | 同owner/session、NFKC比较可定位；不声称跨进程恢复正确 | 所有权图放README |
| [tutorials/typescript-sdk/examples/03_notification_stream.ts](../../tutorials/typescript-sdk/examples/03_notification_stream.ts) | 71行同时教通知、产物、工具、清理；阅读顺序应先投影后验文件 | 外部34字节比较、root过滤成立；最终输出是聚合snapshot，应明确不会在终端逐事件滚动 | committed/callback/final三阶段图放README |
| [tutorials/typescript-sdk/examples/04_low_level_client.ts](../../tutorials/typescript-sdk/examples/04_low_level_client.ts) | 核心循环被藏在low-level-run helper；读者应有明确跳转和阅读问题 | 先订阅再prompt、receipt前过滤、root idle与completed核对 | 用receipt图标出订阅缓冲先于RPC返回，避免以返回时刻为起点 |
| [projects/recoverable-agent-service/README.md](../../projects/recoverable-agent-service/README.md) | 最清楚的职责划分；目前curl只做到submit，缺读者完成“查看终态→重连→下载校验”的路径 | uncertain/no auto replay、持久seq、不可变BLOB与源码测试对应；测试数量只作历史 | 高优先级Run/Conversation双状态图；次选可变文件→验证→BLOB图 |
| [projects/ag-ui-dsh-runtime/README.md](../../projects/ag-ui-dsh-runtime/README.md) | 正确但像发布/审计记录；57–71行大段混合多个概念，先串一个Run的真实流程 | 固定包、stat+cwd+resume无fallback、V4投影匹配；修双终端说明 | 目前仅text箭头；首要generation内外持久资源图，次要两条SSE/业务状态时序 |

### 附件、压缩、持久化、Workflow 与官方 Web

| 文件 | 内容与学习价值 | 专业叙述建议 | 技术/操作核对 | 图示建议 |
| --- | --- | --- | --- | --- |
| [attachment-input/README.md](../../labs/attachment-input/README.md) | 问题明确，输入/存储/传输/回答四层证据完整，清理责任讲得扎实 | 先用“模型说看到了，为什么还要算 hash”导入，再解释三种 ID；把长工具链清单后置 | 包脚本与当前 35 项描述有对应；主路径、私有 cleanup 的范围无明显矛盾 | 保留现有 flowchart；给 local durable/cache/remote 三个区加分组，标出删除责任 |
| [attachment-input/FALLBACK.md](../../labs/attachment-input/FALLBACK.md) | 局部上传失败导致整请求 inline 是很好的反直觉问题 | 第 50 行 RED/GREEN 开发回顾移到验收记录；正文改成“为什么模型答对仍不够” | 两场景、计数、取消区别与代码/固定 upstream 一致 | 高优先级：两张图片 A 已上传/B 被拒绝 → 两者均 inline；A 的远端对象仍存在，由脚本清理 |
| [attachment-input/BUDGET.md](../../labs/attachment-input/BUDGET.md) | reject/offload 对照清晰，base64 计量与服务端 quota 分开 | 正文中英语与中文连写较密；先解释 2000 是哪一层的预算，再列配置 | 1320/1412 等 byte 证据与 4*ceil(n/3) 关系相符；不夸大为 provider 远端错误 | 推荐前后请求图：第一次 [img0,img1] 超预算，落盘 offload(seq,index0)，重试与下一轮均只有 img1 |
| [attachment-input/STALE.md](../../labs/attachment-input/STALE.md) | 删除自有 ID 后服务端真实拒绝，6 步观察很好读 | 第 35 行 retry/staleMappings 用具体 A/B 例子解释；仍保留实际 3 上传 vs 测试支持 4 上传区分 | 实际 once stale 修复、未测试泛化分支明确；无明显矛盾 | 可用小 sequence diagram 表达 DELETE确认 → 旧ID消息400 → A重传/B复用 → 新请求200；非必须新图 |
| [compaction-lifecycle/README.md](../../labs/compaction-lifecycle/README.md) | nonce 经摘要继续写文件，三份独立证据设计优秀 | 在术语首次出现处用一句话定义 surface/checkpoint/bracket；不要先堆配置后讲任务 |阈值、retention、失败摘要不计成本、只读 replay 限定可保留 | 现有 sequence 的“LLM→Session 一次Bash写文件”应增加 Agent/工具与 filesystem，明确 LLM 提议、runtime 执行、文件证明 |
| [compaction-lifecycle/RECOVERY.md](../../labs/compaction-lifecycle/RECOVERY.md) | 10 场景覆盖错误分类、进展、取消的关键差异 | 大表前先讲一次成功恢复，再让表成为差异索引；修正当前29项 | 固定 region/index 支持迟到摘要差异；当前数量过期 | 保留已有 sequence；增一张并列时间轴：manual取消不提交 vs automatic迟到提交但不retry |
| [compaction-lifecycle/REDUCTION.md](../../labs/compaction-lifecycle/REDUCTION.md) | prune replacement 与 image occurrence 分得准确，emoji/metadata 负对照有价值 | 第 67 行真实失败经历可保留为“为什么不能在 idle 直接 prune”的短案例，压缩实现迭代叙述 | 公开重放投影要求、same hash different occurrence 及已提交缩减不回滚与测试一致 | 优先画 occurrence 坐标：同一 attachmentHash 出现在 seq A/index0、seq A/index1、seq B/index0，仅第一处 offload |
| [compaction-lifecycle/PROVIDER-OVERFLOW.md](../../labs/compaction-lifecycle/PROVIDER-OVERFLOW.md) | 正确补上真实服务端错误这一环，没假称真实恢复闭环 | 开头直接答“前课错由 fixture 抛出，这次让供应商亲自拒绝”；运行前放精简预期字段 | 单次请求、0工具、HTTP400+canonical错误同时验收，与代码吻合 | 不必单独画图；可在整个 compaction 学习入口放证据矩阵，标明真实错误+真实摘要成功重试仍未覆盖 |
| [compaction-lifecycle/TRANSACTIONS.md](../../labs/compaction-lifecycle/TRANSACTIONS.md) | 核心结论“Promise失败不代表未提交”清楚，4场景对照有价值 | 用两阶段例子开篇；首次解释 admission=新turn进入许可、bracket=start/end一组记录 | table 与 transaction-scenarios、upstream region 相符 | 高优先级：四条事件/flush泳道，给 append/end/flush/readback/throw 打点，分内存、可读磁盘、调用结果 |
| [session-format-migration/README.md](../../labs/session-format-migration/README.md) | 逻辑格式 vs 物理文件讲得清楚；未来版本拒绝有教育价值 | 先只运行 v1 demo，观察两个 boolean 与目录，再运行测试/扩展v3；完整工具检查后置 | 起始目录矛盾；默认清单还包含重建固定fixture脚本，应标为可选维护，避免与只读观察混排 | 已有 read/write flowchart 足够；为 generation 加“物理文件版本”释义即可 |
| [session-format-migration/RICH-HISTORY.md](../../labs/session-format-migration/RICH-HISTORY.md) | 压缩旧格式、当前版写出、附件重读来源分得清楚 | 第 33 行是一整段执行与验收清单；拆为“旧日志读取/发布/失败对照”和“新V4+附件”两段，给每段一个观察问题 | 起始目录矛盾；脚本确实覆盖 tracked fixtures，正文虽说明，应把生成步骤从普通复现路径中分离 | 两行矩阵优于复杂图：合成旧V1/V3→发布迁移→V4；手工events→发布backend→当前V4；附件对象另列 |
| [workflow-child-lifecycle/README.md](../../labs/workflow-child-lifecycle/README.md) | 正常 workflow 和 continuable 冷恢复目标具体，行为与业务状态分开 | 首先介绍两个一次性child与另一个可续child为何不同；前置知识有链接但仍应给一句解释 | host驱动、公开resume、query依赖、冷恢复maxTokens变化准确保留 | 现有时序参与者多但 child 混为一个角色；补一张 parent/one-shot writer/reader/continuable child 对象图，标持久和活跃状态 |
| [workflow-child-lifecycle/RECOVERY.md](../../labs/workflow-child-lifecycle/RECOVERY.md) | PTC死、worker死、历史迁移分开，flush时点限定很重要 | 第25、27行各承载多套断言；每个故障以“先留下什么/再杀谁/检查什么”三句话讲 | 起始目录矛盾；SIGKILL和catalog测试可支撑正文，无中途恢复过度承诺 | 保留森林重启sequence；加 parent→child→grandchild 图，区分 descriptor记在子、catalog记在父、消息必须走直接父 |
| [web-host-lifecycle/README.md](../../labs/web-host-lifecycle/README.md) | 从页面到文件/持久日志的实测闭环完整，截图确实显示2轮4步 | 操作流程清楚；browser/CDP观察器宜列为可选深入步骤，别与第一次运行混在一起 | 默认Web预算、实时帧与SDK事后展开区分合理；实际截图与文案一致 | 现有图和截图够用；截图可标注原会话/最终回复/2轮4步三个位置，不需要装饰插图 |
| [web-host-lifecycle/CONTROLS.md](../../labs/web-host-lifecycle/CONTROLS.md) | 允许、取消、离线分成不同因果问题，外部append能识别重复执行 | 三个操作段很好；开头增加表格“哪个Session/会生成哪个文件/预期终态”，降低手工ID记录负担 | sandbox denial后再请求审批、completed不等操作成功、离线不cancel均准确 | 现有图把权限决策和网络分支放在一起；三泳道 Browser / Host / shell 可以更准确表达取消与离线差异 |
| [web-host-lifecycle/RECOVERY.md](../../labs/web-host-lifecycle/RECOVERY.md) | 内容最丰富且边界诚实，但一页承担过多独立故障 | 第一节第39行极长，应把同线关联、随机ID负对照、持久审计拆开讲；先修顺序缺口 | Host停止后缺重启；章节跳转冲突；严格验收0/1/2分支是特定实测，不是每台机器应稳定通过 | 最高优先级：prompt requestId去重竞争时序；其次审批 eventId/callId关联图与Host死/子进程/外部写入/repair四泳道 |

### 工程化与插件

| 文档 | 内容与学习路径 | 叙事建议 | 技术核对 | 图示建议 |
| --- | --- | --- | --- | --- |
| [labs/runtime-supervision/README.md](../../labs/runtime-supervision/README.md)（114 行） | 问题、版本、无 key 故障、真实握手/模型、状态、清理完整 | 3/90 行的具体问题很好；将 76–100 行通过“一次超时”贯穿，owner/slot/generation 首次出现各给一句定义 | `supervisor.ts:62-148`、`tests/supervisor.test.ts` 支持关闭确认后重建、隔离及迟到结果规则；固定 rc.2 SDK fresh Session 规则一致 | 增加状态图 idle→running→stopping→idle/quarantined，另画主动 close→closed；图中明确失败请求不重放 |
| [labs/runtime-supervision/POOL.md](../../labs/runtime-supervision/POOL.md)（111 行） | A/B/C/D 故障步骤和练习最接近工程师带练 | 保留这个案例；67–83 行不要再换成抽象术语，持续以 B 回收后 C 才派发解释 | `pool.ts:142-173,199-213,228-253` 和 12 个 pool 行为测试支持 FIFO、queueSignal、drain 规则 | 现流图保留；补 A/B 并行占位、D 取消、B close 后 C 换 generation 的泳道/时间轴，解决派发顺序不等于完成顺序 |
| [labs/sandbox-isolation/README.md](../../labs/sandbox-isolation/README.md)（126 行） | 是本组最好的问题驱动 Lab：先给反直觉结果，再真实对照和源码 | 开篇已经够自然；减少 97–107 行连续断言清单，把一个完整 worker 输出行作为解读示例 | 固定 `profiles.ts:16-21,51-57` 支持 bwrap/Seatbelt；文件矩阵明确实测范围，没有把读写效果扩大为安全认证 | 现目录图与八项矩阵足够；可在 87–95 行链路改成 host runtime→confined Bash→worker 的进程框，标出谁没被隔离 |
| [labs/sandbox-isolation/CONTAINERS.md](../../labs/sandbox-isolation/CONTAINERS.md)（63 行） | 挂载/SSH provider/外部产物/清理有完整证据 | 31/35/55 行过密；先带读 A 成功、B 失败两次操作，再解释 inspect/checksum；长 digest 移验收链接 | `examples/container.sh`、`remote-provider.ts` 与 container tests 相符；未调用 confine、只保证 mount 可见性已明确 | 现图保留，但将容器画成外框，Host B 放框外，SSH channel 与 bind mount 用两种边；不要把未挂载虚线画成可达关系 |
| [labs/run-observability/README.md](../../labs/run-observability/README.md)（119 行） | 去重、usage、隐私和证据边界严谨，缺逐事件演算 | 先拿两个 attempt 的真实字段手算，再抽象 Binding/ledger；不要先投放所有 ID 名词 | 固定 TokenUsage 明确 uncached input 与 cache 分列，现实现/测试和 43300 算术一致；missing usage/observedOnly 约束正确 | 优先增加 seq→Run/attempt 的表和离散时间线；无需再画一张抽象架构图 |
| [labs/protocol-semantics/README.md](../../labs/protocol-semantics/README.md)（102 行） | 版本、fake/package/command 三类证据划分清晰；一个段落承载过多 ACP 概念 | 将 36/38/59/61 分成“提交、看到文本、判断完成、恢复”的连续短段；直接解释 message chunk 为何不代表逐 token | `versions.json`、SdkProbe 与固定 ACP codec 支持关键语义；目录起点有歧义 | SDK 与 ACP 对称时序图；另用第二进程 resume 小图区分恢复上下文和历史 update 回放 |
| [labs/protocol-semantics/ADAPTERS.md](../../labs/protocol-semantics/ADAPTERS.md)（120 行） | 共同场景/负对照/能力描述完整；7.8 追加后共同生命周期没有重新整理 | 103/105 行应拆成设置、一次任务、输出、关闭四段；把早期 Hermes 失败细节留验收，正文保留当前启动警告契约 | 本次实际运行 fake comparison 13/13；发现 DSH drain/reuse 与 CLI terminate/one-shot 差异未进入共同说明 | 四入口的终态与生命周期表优先；CLI init→events→terminal→process exit 图可简小，不需要复杂动画 |
| [labs/cordis-plugin-lifecycle/README.md](../../labs/cordis-plugin-lifecycle/README.md)（62 行） | 主题覆盖很广，但作为单课缺少第一次成功后的解释与练习 | 最值得重写的页面：以 consumer 等 provider、移除 provider、恢复 provider 三步组织；把 HMR、打包、preset 分成后续层次 | lifecycle/agent-loop/plugin-boundaries/preset tests 支持文中机制；命令目录需修；源码匹配 V4 toolCallId | PENDING/ACTIVE 与 cleanup 时序优先，其次 live tools/result→AgentLoop commit→durable tool/result 两泳道 |
| [projects/recoverable-agent-service/TENANCY.md](../../projects/recoverable-agent-service/TENANCY.md)（136 行） | 环回真实 HTTP 与受控 runtime 的组合解释清楚，权限与工具隔离边界正确 | alpha 造记录、beta 用相同 ID 404 的故事很好；可加一条“为什么 404 而非暴露对象存在”的解释；收尾要具体 | middleware 在认证后选择 child app、剥离 Authorization、严格 selector、no-store/Vary 与文字一致；`32–256 位`应改字符 | 现身份路由图足够；可把 alpha DB 查询失败的 beta 请求标在图上，不必新增大图 |
| [projects/recoverable-agent-service/EVAL.md](../../projects/recoverable-agent-service/EVAL.md)（143 行） | 数据、实际执行、评分、负对照、离线重评界限最完整 | 先给一个 success 和一个 tool-error 的检查对照，让“评测通过不等于任务成功”有具象结果；把 watchdog 细节置高级说明 | run_case 不读取 expected；17 项观察、关闭后复核、replay 与数据库比较均有实现与测试支持。历史 7.6 未完成记忆已过时，当前仓库有完整代码/验收 | 现 input→evidence→grader 图很好；补 recovery 的旧 Run/新 Run 与 Session 换代时序；不需要新增可视化网站 |

## 建议的编辑次序与验收方式

第一轮先修 F1–F9：错误/含混的恢复与生命周期语义、凭据加载、目录、Web操作顺序、阅读入口、过期状态及两张误导图。用没有预先 export Key 的新 shell 检查命令说明，使用 fake runtime 验证阅读页面即可；不需要为文案修正重发付费任务。

第二轮选择 Python 02、Cordis、Session surface、AG-UI 四篇作为样章，统一到“具体问题—最小运行—输出解读—机制—小练习—范围与下一步”的阅读节奏。这个顺序是叙述指导，不要求每章复制相同小标题。样章先解决阅读体验，再把同一原则应用到其余正文与英文镜像。

第三轮按上面的高优先级关系补图，先重排过宽图。每张图的验收同时看四件事：参与者是否真实、箭头究竟表示调用还是数据/所有权、失败/恢复条件是否明确、在正常正文宽度与窄屏下是否可读。不得把实际运行没有保证的顺序画成确定顺序。

最后做一次全章顺读检查：入口前置不互相循环；每段命令声明起始目录；必要变量在使用前已赋值；常驻服务标清终端；一次性故障探针不被章节顺序要求重跑；收尾保留证据所需状态而不遗留凭据。相同事实保留一个权威位置，历史报告保留原日期，当前正文只链接与当前结论相关的证据。

初审交付包含本报告和图表诊断截图；当时尚未修改章节。后续修订状态由页首链接的修订记录维护。
