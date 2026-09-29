# 2026-09-29 第五批：Cordis、AG-UI 与机制笔记

接续 `effa5f3`，按[设计](../superpowers/specs/2026-09-29-plugin-agui-internals-design.md)与[计划](../superpowers/plans/2026-09-29-plugin-agui-internals.md)固定 npm `0.1.7-rc.2` / `477b4f420553e8a52c2fbccc464d7561b239c443`、Cordis `4.0.4`。没有修改 upstream 或个人会话，未推送远端。

## Cordis / preset

原创 package 保留 `./tool`、`./listener`、proof/audit/health 接口，V4 durable listener 改为读取 `event.data.message.toolCallId`。Preset probe 验证 proof-only 子插件声明可解析且不泄漏 Host 的全局工具；不扩大为完整 Agent activation、热更新或 sandbox 验收。

在 `labs/cordis-plugin-lifecycle` 执行 frozen install、`pnpm test`（26 passed）、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 和 `pnpm pack:smoke`，全部通过。使用 pnpm 12.3.4、Node 26.7.0、macOS arm64。

真实公开 sdk-minimal + patch 运行得到一次 tool/call、一次 V4 tool/result。外部读取 proof 为 27 bytes、mode 0600、SHA-256 `3f119a4f8daeac10a4f80ecec504394590dc60ddeeda42008d888c1f68490a32`；audit 的 live/durable 使用同一 call ID，health 为空。外部 ps 观察到的 1 个后代进程在退出后消失，stderr 为空。独立 reviewer 另跑 3 个文件 / 15 个 focused tests，无待修问题。

## AG-UI runtime

毕业项目使用同版本 npm dsh 的公开 profile 和两份有序 patch，替换旧 source-demo launcher/源码构建 attestation。持久 `stateRoot/dsh-home` 与 Session 数据跨 generation 保留，generation 内的配置、编译插件副本和临时 home 在确认退出后清理。

仍通过项目 deployment adapter 恢复 Session：`persistence.stat(id,{signal})` 的 snapshot.header 提供 cwd，经 canonical realpath 核对后调用官方 agents.resume。stat/resume 失败不回退到 fresh create；stock SDK 没有因此新增 resume RPC。协调者独立跑了 5 个适配器测试和 2 个双 Context/真实 JSONL 测试，验证 V4 旧上下文进入第二次模型请求、turn 1→2 和 corrupt storage 拒绝。

实际 profile 联调发现并修复两个安装问题：已有条目不能直接换 name，需要禁用 stock SDK server 并插入项目适配器；复制后的插件需要正确的已安装 dependency plane，同时核对 Cordis/tools 与 Host 一致。system-prompt patch 也必须保留 includeHarnessIdentity/includeRuntimeContext 开关，避免额外上下文改变 proof 输入。没有退回私有 launcher。

### 本地检查

工作目录 `projects/ag-ui-dsh-runtime`，pnpm **11.7.0**（此子项目现有 pin，与 Cordis lab 不同），Node 26.7.0：

| 命令 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过 |
| `pnpm test` | 19 files / 93 tests passed |
| `pnpm test:web` | 8 files / 25 tests passed，是全套测试的 Web 子集 |
| `pnpm typecheck` | shared/server/web 三个 compiler faces 通过 |
| `pnpm lint`、`pnpm format:check` | 通过 |
| `pnpm build` | server 与 production web build 通过 |
| `pnpm smoke:server` | foreign-cwd server smoke 通过 |

旧 source attestation/launcher 被移除，对应测试随它们删除；业务 store/coordinator/web 测试保留并更新 V4 fixture。AG-UI 0.0.57 的依赖闭包仍为同一版本。

### 真实 API、恢复与业务事件

使用独立 disposable app state，从项目目录执行：

```sh
node --env-file=<本地凭据文件> scripts/real-package-e2e.mjs
```

最后一次执行发生在生命周期、模型终态、严格 nonce 和 artifact metadata 校验修复之后，观察到：

- 两个 Conversation、四个 succeeded Run；每个 Run 恰好一次 proof call/result。
- 四份下载的 artifact 与完整输入字节、size、SHA-256 匹配；四组 live/durable audit 对应，health 为空。
- idle restart 把 runtime generation 从 1 推到 2，Conversation 的 Session reference 不变。
- 第二次请求与其 proof 文件均不含随机代号；最后一条 root committed assistant message 和最终 AG-UI 文本精确等于代号。模型唯一可见工具是写 proof，不能借文件读取代号。
- 主动断开一次 AG-UI 请求后，业务 Run 仍到 terminal；持久 cursor replay 返回 32 个后续 ID，严格按游标恢复。
- 外部 ps 观察到的 2 个 runtime 后代在关闭后都消失，stderr 为空。

这些结果验证固定版本的项目部署适配器，不是 ACP，也不是 stock SDK 原生 resume；没有验证任意旧用户 app state 的升级或生产多租户安全。

## 浏览器

协调者另用一个独立状态目录和 `127.0.0.1:4327` production build，在 browser session 中创建 Conversation 并发送 `BROWSER_AGUI_V4_PROOF`。

真实结果为一张工具卡、一条最终 assistant 回复，Run succeeded、cursor 37；持久 raw 记录中的 turn/end 另外确认 completed。下载文件精确为 21 bytes，SHA-256 `89ec0ccbfdf91ab374596be1ed4942ee5491774259c520fe3582e4bc684762ca`。刷新到 375px 后，历史 hydration 仍只有一张卡和一条回复，没有页面水平溢出。

错误 UI 用 network route 返回不合法 restart 响应测试（未调用模型）：页面显示可 dismiss 的错误并保持已有消息。随后解除 route。最初 mobile picker 有一个 landmark violation；改为 Mobile conversations nav 后，在最终 rebuilt server 上重新加载既有状态，完成以下无模型复查：

- desktop Axe：0 violations、43 passes、0 incomplete。
- 375px Axe：0 violations、44 passes、0 incomplete。
- 无捕获到的非预期 JS errors；人工查看 desktop/窄屏截图。
- 实际点击 idle restart 后 health 显示 generation 2、activeRuns 0；已有业务历史保留。

首次真实浏览器请求早于最后两项后台 race/outcome 修复，但其持久 turn/end 已独立核对为 completed。最终 hydration/landmark/idle-control 复查使用修复后的 build，没有重复模型请求。首次浏览器 server 的 1 个被观察到的 DSH 后代随正常关闭消失；最终 server 也正常退出。PID 采样不覆盖未观察到的短命/逃逸进程。

## 七篇机制笔记

`how-dsh-works/` 的七篇正文逐条改为固定新 tag，特别更新 profile/preset、Agent.ctx/initiator、V4 flat tool message、immutable generation、context series 与 workflow-ptc。没有把概念描述写成不存在的 AgentRuntime 类型。

新增 `node --test how-dsh-works/probes/published-core.test.mjs`，3/3 通过，另通过 lint/format。只读复用精确安装的发布库，验证：idle inject/followup、live/embedded stream、未知工具错误进入下一 step、runtime-context 去重与变化。协调者加强了被比较文本必须存在的断言，避免 -1 的 indexOf 值误过；修复后 3/3 再次通过。

旧版 2026-08-31 的 603 tests 和原命令移到 `historical-2026-08-31.md`，不算新版结果。50 个固定源码路径核验存在。**完整 compaction、workflow-ptc、child cold resume、官方 Web Host 等运行链未重跑**，对应文章明确标注 source-only 或待验证；没有为凑数量拿 master 或旧测试充数。

## 独立 review 与限制

Review 修复了 startup/shutdown 可能漏掉晚创建 owner、并发 restart/新 run 缺少生命周期门闩，以及 max-tokens 在已有正确 artifact 时被错误判为 success。关闭现在先阻止接单、等待 startup，再关闭最终 owner；失败回收保留 generation。模型非 completed 终态记为 failed，已有精确 artifact 保留。5 个 targeted lifecycle/outcome 回归通过独立复核。

Core、Cordis、resume adapter、projector、package lifecycle 与共享文档没有剩余可操作问题。当前完成版本刷新与证据整理，工程化进程池/隔离/eval 等专题以及上述未执行链仍按路线推进。

最终文档检查：66 个 Markdown 文件的 230 个本地文件链接均存在（未验证 URL 可达性或锚点）；本批七个 Mermaid 图通过 Mermaid 11.16.0 parser，`git diff --check` 通过。
