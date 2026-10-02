# Phase 7.3：身份认证与租户

目标是让学习者运行两个租户并验证认证、资源访问与恢复操作，而非搭建完整 IAM。沿用 Python SDK0.1.5rc1 与既有业务服务。新增独立认证入口，保留原单租户入口供之前课程使用。

采用服务端静态高熵 Bearer credential 的 SHA-256 verifier 映射到 tenant ID。配置只包含摘要，不保存明文 token；客户端 token 只通过 Authorization header。不是 JWT/OIDC，不实现账号注册、角色、刷新或在线吊销。更换配置并重启会终止既有连接并生效。

一个 tenant 对应独立 create_app、SQLiteStore、RunCoordinator、workspace 和 dshHome；共用一个应用进程。认证入口在路由之前选择应用，覆盖 health/docs/OpenAPI/SSE/download/write/recovery；不提供未认证 health。tenant ID 仅来自配置和验证后的凭据，不从 URL、请求 body、query 或 X-Tenant-ID 接收。所有请求只向当前 tenant store 查询，不存在或其他租户 ID 均404。body 拒绝未知字段，因此不能覆盖 tenant/session。摘要允许多个凭据映射同一 tenant；此课租户内具有同等权限。

接口：tenancy.create_tenant_app(tenants: Mapping[str, FastAPI], credentials: Mapping[str, str]) -> FastAPI。credentials key 为64位小写 SHA256 hex，value 为 tenant id。构造验证非空、摘要、tenant id安全格式、全部tenant有凭据、引用存在、应用对象不复用；配置失败不回显值。持有映射副本。外层 lifespan 使用 AsyncExitStack 管理全部子应用，启动失败关闭已启动应用。

ASGI middleware 对 HTTP 只接受一个 Authorization header，scheme大小写不敏感，token为32–256位 URL-safe随机串；缺失/错误/重复统一401与WWW-Authenticate。不读请求 body；去掉认证header再调用子应用。拒绝 X-Tenant-ID/X-Session-ID，以及 tenant_id/session_id/dsh_session_id/access_token query 参数。认证入口关闭包含完整URL的access log；所有 HTTP 响应 Cache-Control:no-store、Vary:Authorization；不记录token、不把token传给业务/runtime。WebSocket不支持，拒绝。

配置入口 tenant_server.create_from_env 读取 RECOVERABLE_AGENT_TENANTS JSON：{"tenant-id":{"token_sha256":["digest"]}}，仅环境变量承载配置。显式 RECOVERABLE_AGENT_TENANT_ROOT 默认.data/tenants，下按安全tenant ID分别建service.db/workspace/dsh-home；忽略旧单租户数据库环境变量。schema1与旧数据不迁移、不自动分配tenant。严格拒绝重复JSON key/未知字段/空列表/重复digest和嵌套或重合的存储路径；启动时若路径为符号链接、数据库存在额外硬链接、目标类型错误或偏离所配置根目录应拒绝。配置根为受信任运维目录，不声称防御同OS用户事后改目录。

测试：先RED认证/跨租户测试，再实现；真实HTTP环回探针用可控runtime完成A/B产物与SSE，验证401/404/422、两个相同幂等key仍独立、恢复隔离、日志不含token；真实DSH双租户模型调用单列，可运行但只覆盖本机路径。没有工具sandbox或多进程claim，不把进程/目录划分视为安全隔离。
