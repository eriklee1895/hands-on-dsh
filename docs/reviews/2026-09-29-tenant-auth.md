# Phase 7.3：认证与租户 API 数据访问验收

2026-09-29 完成[身份认证与租户教程](../../projects/recoverable-agent-service/TENANCY.md)。基线 `b05fca9`；新增独立认证入口，将 Bearer token 摘要映射到租户自己的 FastAPI 应用、SQLite、coordinator、workspace 和 dshHome。原单租户入口保留；两个入口的 Conversation/Run 请求均拒绝未知字段。业务 schema、幂等语义与 DSH 生命周期不变。

## 环境与验证方式

macOS arm64、Python 3.10.20；锁定 Python SDK/runtime `0.1.5rc1`，FastAPI `0.141.1`、Starlette `1.6.0`、Uvicorn `0.52.4`、httpx2 `2.12.0`，依赖和 uv.lock 无变更。认证使用纯 ASGI middleware，不缓冲 SSE；结构参考[Starlette 官方 middleware 文档](https://github.com/kludex/starlette/blob/main/docs/middleware.md)，每个请求的认证状态仅保存在调用局部。

固定 Python SDK 会在启动子进程时复制服务进程环境，源码为 [`client.py`](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/python/sdk/src/deepseek_harness/client.py)。因此配置生成器把服务端摘要与客户端明文 token 分开保存；HTTP 层在交给业务应用前移除 Authorization。

## Keyless 检查

项目目录中的验证结果：

| 命令 | 结果 |
| --- | --- |
| `UV_NO_SYNC=1 uv run --offline --python 3.10 pytest` | 171 passed，1 个原有真实 E2E deselected |
| `uv run --offline --no-sync ruff check .` | 通过 |
| `uv run --offline --no-sync ruff format --check .` | 通过 |
| `uv lock --offline --check` | 通过，36 packages，锁文件未变 |
| `uv run --offline --no-sync --python 3.10 python examples/tenant_probe.py` | 实际环回 HTTP 探针通过，runtime 为可控实现 |

`--no-sync` 使用已安装的锁定环境，避免本机另一个 uv 操作持有全局 cache 锁时重复等待，不绕过测试或依赖版本检查。新增测试共 32 项：租户路由 11 项、配置入口 21 项；既有 139 项通过。新增断言先观察到 RED，再实现或修复。

覆盖无效/缺失/重复凭据、未知身份字段、mapping 副本、header 移除、no-store/Vary、WebSocket 拒绝、部分启动失败回收、全部子应用 teardown；跨租户查询/提交/恢复/SSE/下载均被拒绝；同一个幂等 key 可在不同租户独立使用，本租户重放不新建 Run。配置验证包括重复 JSON key、摘要复用、非法 ID、符号链接、硬链接与文件类型。

最终默认探针经过真实 Uvicorn/TCP，观察到 5 次未认证或无效认证 401、6 次跨租户 404、9 次身份字段拒绝；两个 runtime 各写入 17-byte proof，分别验证下载字节/哈希、SSE 4 个事件与游标重放。两个 owner close 已确认，服务线程退出。`access_token` query 的拒绝测试使用实际随机测试 token；对日志、业务存储、产物和可用 session 文件做字节扫描，没有命中两个 token。这个检查不保证任意业务文本或外部代理日志自动脱敏。

文档检查：两个 Mermaid 图通过 Mermaid 11.16.0 解析，变更文档的 47 个本地文件链接均存在，`git diff --check` 通过。

## 手动配置入口

独立临时目录中实际执行了 `examples/create_tenant_env.py`，两个环境文件模式均为 0600；再次执行返回非零，已有文件保留。只加载服务端环境文件启动 `python -m recoverable_agent_service.tenant_server`，监听 127.0.0.1:8001；无凭据 health 返回 401、alpha 创建 Conversation 返回 201、beta 读该 ID 返回 404，服务日志不含生成的 token，进程已停止。

认证 CLI 关闭完整 URL access log，测试检查 Uvicorn 的 `access_log=False` 参数；自定义启动器和外部代理仍需自己的日志策略。原单租户启动器没有改变。

## 真实 DSH 证据

实现 agent 执行了两次独立的 `uv run --env-file <ignored .env> python examples/tenant_probe.py --real`，每次均创建全新临时存储和随机凭据，每个租户各提交一个模型任务。两次都成功；第二次用于验证新增的 adapter close 确认，不是失败后的自动重试。临时目录在确认回收后删除，原始结果保留于执行工具输出。

第一次约 30 秒，两个租户各 15 个 SSE 事件；已验证 `succeeded/finish_reason=completed`、同租户幂等重放、跨租户拒绝和下载精确字节：

| 租户 | Run ID | DSH session ID | 17-byte proof SHA-256 |
| --- | --- | --- | --- |
| tenant-a | `3fbe0521-25d6-4241-881f-d9411677b08c` | `a5757572-9b3d-46d2-8123-4d9b56e11fa0` | `735ccbf78aec6462b1245064fa0f4d86901a8f630aa85c2843aa4352f291e22f` |
| tenant-b | `dff36ca4-de45-4594-a0e0-43bd7b9eb825` | `bd7944f8-81ae-476d-a42f-34cc341cf4bb` | `7219d5808029c09ee7cbfc9341f637886f2c6ece082fd6155a2173acd8ef6f2e` |

第二次 23.3 秒，退出码 0、stderr 为空，两个租户的 proof 哈希分别与第一次结果一致，6 个跨租户 404、9 个身份字段拒绝、两个 runtime close 和服务停止确认全部通过。执行 agent 的外部 `ps` 采样累计观察到 20 个后代 PID，退出后这些已观察 PID 均不存在；这是本次采样结果，不代表任意脱离父子树的工具进程都被覆盖。

这两次真实调用之后，示例补上显式 `provider=deepseek-official`、关闭 access log、用真实测试 token 做 query 拒绝检查，以及保留目录的错误提示；这些最终调整经过 keyless HTTP 探针与 Ruff 检查，未额外重复模型调用。真实请求使用模型 `deepseek-flash`。没有注入真实 runtime 崩溃或 close 失败。

## Review 与范围

独立安全/生命周期 review 找到一个 P1：预先把 beta 数据库硬链接到 alpha 数据库后，Beta 查询 Alpha Conversation 可返回 200。修复后，启动验证拒绝额外硬链接；reviewer 重新执行原复现，确认在创建任何子应用前失败。最终 31 项相关 focused tests 通过，后续新增的第 11 个路由用例也包含在 171 项全量 keyless 回归中，无待修问题。另一位 reviewer 核对教程与命令，没有发现教学或能力范围表述问题。

本课完成的是 HTTP 认证和正常应用路径的数据访问隔离。运行多个租户仍使用同一系统用户和同一应用进程，DSH 工具没有被限制到各自目录。独立 DB/home/workspace 不等于 sandbox；租户配额、OIDC、生产 TLS、在线 token 吊销、持久进程池与分布式 claim 尚未实现。下一节为 [7.4 Workspace 与执行隔离](../learning-paths/engineering.md)。
