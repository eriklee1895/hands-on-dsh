# 跨引擎适配验收记录（2026-10-02）

范围：[协议语义 lab](../../labs/protocol-semantics/ADAPTERS.md)中的 Codex `exec-jsonl`、Hermes `chat-stream-json`，保留 DSH SDK/ACP 的原有检查。运行环境为 macOS arm64、Python 3.10、Codex CLI `0.156.1`、Hermes Agent `0.21.5`（upstream `3da4a423`）；DSH 锁定 `0.1.7-rc.2`。CLI 版本由真实 binary `--version` 确认；[Codex 官方 JSONL 用法](https://developers.openai.com/blog/eval-skills)和 [Hermes 对应源码](https://github.com/NousResearch/hermes-agent/blob/3da4a42359c8b50a6ea6563a6c1f989e4dd1fbc4/hermes_cli/stream_json.py)用于选择接口，不能取代实际任务结果。

## 已确认

- Codex `--engine codex --server binary`：最初两个随机任务报告 `selected=2, passed=2, failed=0`；其中 nonce 当时使用 `.strip()`，只能证明忽略边缘空白后的匹配。文件任务 `result.txt` 的 UTF-8 字节精确匹配并观察到 1 个工具事件，文件 SHA-256 `97ab5007443574a8ab37699f24be060b8cb723695dbcb959443ed3a51abf5106`。严格规则修复后用**全新** nonce 再运行一次：原始文本精确匹配、无尾随换行、零工具事件，`turn.completed`、进程退出 0、进程组消失且状态删除；答案 SHA-256 `5859d3a463815a9d55b31e3042a7f81ab907319788321a8ae6b080635684dcc6`。
- Hermes `--engine hermes --server binary` 在启动警告修复后用新随机输入运行：最初 `selected=2, passed=2, failed=0`，其中 nonce 同样受 `.strip()` 的早期宽松规则影响；文件 `result.txt` 的 UTF-8 字节精确匹配并观察到 1 个工具事件，文件 SHA-256 `2619448d00ebf604881264d4cd8e94695185dc482dea6011a7960d55b11a185a`。严格规则修复后再用**全新** nonce 运行一次：原始文本精确匹配、无尾随换行、零工具事件；末尾 `result.exit_code=0`、进程退出 0、进程组消失且状态删除，`native.startupWarning=tirith-unavailable`；答案 SHA-256 `d90273868793a002d7b101e4a6982e03df81e76739ae6db90620ce191518d371`。早期不确定任务没有重放，所有任务均使用隔离 home。
- 首次专项复核阶段的 keyless 全 lab `pytest tests`：133 passed；最终关闭竞态修复后的137项结果见文末。受控子进程覆盖完整终态、部分输出后 EOF、失败终态、超时及输出超限后的进程组回收、精确文件字节、严格 nonce 空白拒绝、凭据准备失败清理，以及固定 Hermes 启动警告的位置/次数校验。Ruff check、format check、`uv lock --check`、相对链接和 `git diff --check` 均通过。

## 保留的早期失败与根因

Hermes 首个真实比较任务返回 `AdapterExecutionError`，当时的 CLI 摘要只输出异常类，没有保存 kind；因此不能反推首个任务的根因或结果。随后一次独立文件任务观察到 `invalid-event`（非 JSON stdout），stderr 尾部为 0 字节；未取得原生 `result`，进程经 SIGTERM 回收（returncode -2），进程组消失且临时状态删除。这两条任务结果不明，没有重发，也没有算作通过。

在已安装的 Hermes `cli.py` 找到 `_ensure_tirith_security()`：当 `tirith` 扫描器不可用时，即使 `--format stream-json`，它也用 `_cprint` 向 stdout 输出固定警告。用隔离 home、假 key 和 `127.0.0.1` 本地假 provider 的 keyless 探针复现 `system/init` 后出现这条非 JSON 行；配置隔离最小 `security.tirith_enabled: false` 的第二探针得到纯 JSONL，确认污染源。最终 adapter 保留 Hermes `--safe-mode` 与默认安全配置，只识别固定警告一次，并保留 `startupWarning` 证据；未知文本继续返回 `invalid-event`。启动警告修复后运行两个全新真实任务；随后严格nonce规则修复后，再用一个新nonce完成原始文本匹配验证。原生取消、resume、permission、逐 token 消费、Windows 与生产多租户隔离均不在本次验收范围。

## 复现与检查

从 `labs/protocol-semantics` 运行：

```sh
uv run --python 3.10 pytest tests
uv run --python 3.10 ruff check .
uv run --python 3.10 ruff format --check .
uv lock --check
uv run --python 3.10 python -m protocol_labs.comparison
uv run --python 3.10 python -m protocol_labs.comparison --negative-control
uv run --python 3.10 python -m protocol_labs.comparison --engine codex --server binary
uv run --python 3.10 python -m protocol_labs.comparison --engine hermes --server binary
```

最后两条会访问各自当前配置的模型，不属于 keyless 回归；故障后先检查远端与文件副作用，不自动重试。输出仅包含状态、布尔值、hash 和有限终态字段；手工确认残留进程已退出后，才可清理任何未被自动删除的 `codex-adapter-` / `hermes-adapter-` 临时目录。

专项独立review提出并关闭3个P2：nonce边缘空白过宽、Hermes双override绕过provider约束、凭据准备失败后的状态清理。新增相应负对照及启动警告位置/次数检查后，133项测试与静态检查通过；独立复核无剩余P1/P2。

## 2026-10-02 CLI 进程退出竞态修复

后续全目标复核在 Hermes `warning-after-result` keyless fixture 中复现了进程退出与进程组 `SIGTERM` 的竞态：信号可能短暂返回 `EPERM`，原关闭路径于是跳过子进程等待、输出流收尾及状态删除。修复后对同一 owned child 做有界等待，独立检查进程组消失，并有界完成或取消输出流 reader；只有进程已回收、组已消失且 reader 已收尾才删除临时状态。持续拒绝信号且组仍存活时保留状态并报告 `PermissionError`，不把 `EPERM` 解释为组消失，也不改用其他信号绕过拒绝。受控测试先在旧代码上确定性失败，再在修复后通过；最终协议 suite 为 136 passed，Ruff、format、lock 与 diff 检查通过。`warning-after-result` 原 fixture 在本机 100 次独立 keyless pytest 进程中全部保留 `invalid-event` 并确认组消失与状态删除。此记录不改变上文早期 Hermes 两条未知结果，也不追加真实模型验收。

同日补充复核发现 `SIGKILL` 被拒时第二次有界等待仍被跳过。新增受控 CLI 忽略 `SIGTERM`，输出非法尾行后关闭 stdout/stderr，并在 owned `SIGKILL` 返回模拟 `EPERM` 后正常退出；该测试在中间代码上确定性失败，修复为无论信号错误与否都对未回收的 owned child 做第二次有界等待后通过。拒绝 `SIGKILL` 后没有发送其他信号，持续拒绝时仍保留状态并报错。最终协议 suite 为 137 passed，Ruff、format、lock 与 diff 检查通过；修复后的 `warning-after-result` fixture 为 100/100 独立 keyless 进程通过，新增 `SIGKILL` 竞态 fixture 为 20/20 独立 keyless 进程通过。没有新增真实模型调用。

最后一次独立定向复核确认SIGTERM与SIGKILL两阶段EPERM都等待同一个自有child，再独立核对进程组；持续拒绝不追加信号、状态保留。四项定向检查通过，原P2完全关闭，无剩余P1/P2。
