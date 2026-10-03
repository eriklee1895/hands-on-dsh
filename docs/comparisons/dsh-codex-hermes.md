# DSH、Codex、Hermes：同一任务的不同终态

让三个引擎都写出同一个文件，很容易得到三个“成功”的回答。适配器还需要确认原生终态、进程退出，以及磁盘上真正留下的字节；否则统一接口会把不同程度的完成混在一起。

本表比较的是 [协议语义 lab 的适配层](../../labs/protocol-semantics/ADAPTERS.md)，不是三个产品的全部能力。应用可以统一「提交一条任务、接收结果、关闭自己启动的进程」；能否确认完成，必须回到各入口的原生事件。测试版本：DSH `0.1.7-rc.2`，Codex CLI `0.156.1`，Hermes Agent `0.21.5`（upstream `3da4a423`）。这些版本、渠道和本机配置的观察不能推到其他版本或账户。

| 入口 | 本 lab 的传输与终态 | 成功判据 | 真实任务证据 |
| --- | --- | --- | --- |
| DSH SDK JSON-RPC | stdio JSON-RPC；matching inbox receipt → 根 `turn/end=completed` → 根 idle | completed | 已在固定 npm 包完成 nonce；另见 [DSH 验收](../reviews/2026-09-30-runtime-adapters.md) |
| DSH ACP v1 | stdio JSON-RPC；`session/prompt` 返回 `stopReason`，文本由 committed `session/update` 到达 | `end_turn` 仅代表 settled；不推出根 completed | 已在固定 npm 包完成 nonce；跨进程 resume 单独验证 |
| Codex CLI | `exec --json` 的 JSONL 事件流；`thread.started` 与 `turn.completed` / `turn.failed` | 唯一终态 `turn.completed` 且进程退出 0 | 本机 nonce 和 workspace 文件均通过 |
| Hermes CLI | `chat --format stream-json` 的 JSONL 事件流；`system/init` 与 `result.exit_code` | 唯一终态 `result.exit_code=0` 且进程退出 0 | 新 nonce 和 workspace 文件均通过；记录固定启动警告 |

Codex CLI 的 [官方用法](https://developers.openai.com/blog/eval-skills)说明 `exec --json` 的 stdout 是 JSONL，`item.*` 记录操作；实际本机成功还要求 `turn.completed` 和进程退出一致。Hermes 的 [固定源码 `stream_json.py`](https://github.com/NousResearch/hermes-agent/blob/3da4a42359c8b50a6ea6563a6c1f989e4dd1fbc4/hermes_cli/stream_json.py)声明 `system/init → text/tool_use/tool_result → result`；[同版本 one-shot 退出码](https://github.com/NousResearch/hermes-agent/blob/3da4a42359c8b50a6ea6563a6c1f989e4dd1fbc4/hermes_cli/cli_single_query.py)以完成、失败、中断分类。Hermes 的 [CLI 启动代码](https://github.com/NousResearch/hermes-agent/blob/3da4a42359c8b50a6ea6563a6c1f989e4dd1fbc4/cli.py)会在 `tirith` 缺失时把固定警告写到 stdout；本 adapter 只识别这一条、只允许它在 `system/init` 后且 `result` 前出现一次，并报告 `startupWarning=tirith-unavailable`。其他非 JSON 行仍使任务失败，不能用部分 stdout 或进程回收推断模型完成。

| 能力 | DSH SDK | DSH ACP | Codex `exec-jsonl` | Hermes `chat-stream-json` |
| --- | --- | --- | --- | --- |
| prompt / owned process close | supported | supported | implemented；真实通过 | implemented；真实通过 |
| session close | unsupported | supported | not-integrated | not-integrated |
| resume | unsupported | supported | not-integrated | not-integrated |
| native cancel | unsupported | probe-only | not-integrated | not-integrated |
| permission | unsupported | probe-only | not-integrated | not-integrated |
| token stream | unsupported | unsupported | not-integrated | not-integrated |

| 生命周期 | DSH 两个 adapter | Codex / Hermes CLI adapter |
| --- | --- | --- |
| 每实例任务数 | 成功后可继续接纳，单次仅一个在途 prompt | 一次 prompt，下一任务新建实例 |
| 活动期 close | 先停止接纳并等待自有操作，再关闭协议与回收 | 终止仍存在的自有进程组并回收 |
| 完成后的状态 | 可复用的 open | finished，不再复用 |
| 是否代替 native cancel | 否 | 否 |

共同方法名便于调用，但调用方仍需按这张表管理对象。尤其不要把 CLI 的 close 当成等待工作自然完成的 drain。

`unsupported` 是固定 DSH 入口的限制；`not-integrated` 只说明本适配层没有实现或验收，不能当作产品不支持。Codex 与 Hermes CLI 即使暴露 resume/cancel 相关命令，本 lab 仍只接单次任务。`close()` 杀掉卡住的进程组是资源回收，不是 native cancel；本地 timeout、EOF 和部分文本也都不是 completed。非零 `tool_events` 只表示观察到工具事件，不能跨引擎比较工具调用次数。

两条 CLI 任务分别使用临时 workspace、HOME 和引擎状态目录。Codex 仅复制 auth 文件并显式选择当前配置的 model；Hermes 仅提供当前配置的 DeepSeek key 与 model/provider；都不加载个人 MCP/rules，也不更改原有登录。只有进程组消失才删除临时目录。业务应用仍应独立保存 Run ID、幂等键、权限决策和产物校验，不能把这里的 CLI session ID 当作业务任务状态。

复现命令、负对照和清理规则见[实验章节](../../labs/protocol-semantics/ADAPTERS.md)；2026-10-02 的正负证据见[验收记录](../reviews/2026-10-02-cross-engine.md)。
