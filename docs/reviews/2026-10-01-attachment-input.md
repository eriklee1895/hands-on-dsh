# 生产附件存储与真实图片输入验收

日期：2026-10-01；基线 `e679d6d`。产物为 [Attachment Input Lab](../../labs/attachment-input/README.md)，固定 npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`，Sharp `0.35.5`。macOS arm64、Node `26.7.0`、pnpm `12.3.4`。

## 证据范围

真实发行版 `LocalAttachmentStore`、SDK profile、JSONL V4、DeepSeek provider；图像是父进程生成的随机色块测试数据。一次真实验证包含两张不同象限排列的图、2个成功 Messages 响应与2个 Files 上传。Key 沿用已有环境，子进程使用隔离 home/workspace；不使用个人图片，不修改 upstream，不 push。

首次视觉答案精确匹配随机真值；第二轮也匹配，但可以利用第一次文本答案，故只作为历史与传输复用证据。两轮都实际发送两个相同次序的 Files 图片引用。不是两次独立视觉评测，也没有真实 inline fallback。

| 项目 | 实际结果 |
| --- | --- |
| 源 PNG | 512×512；5546 / 5575字节 |
| 归一化 JPEG | 256×256；1283 / 1282字节；原尺寸字段512×512 |
| 上传 | 2个 HTTP 200，已确认 ID；hash 与独立重读的请求版本一致 |
| Messages | 2个 HTTP 200，每个2个 Files 引用、0个 inline；hash/顺序一致 |
| Agent | 2个 completed turn、0次工具调用 |
| Session | 22个事件；runtime关闭后独立重开 V4，完整内容与现场事件相等 |
| 清理 | 本次2个已确认上传均显式删除；脚本成功删除自有临时目录，exit 0 |

详细 hash 与传输计数保存为[脱敏元数据](../../labs/attachment-input/evidence/2026-10-01-live.json)。其中 `variantId` 是缓存身份，并非字节hash；本次请求版本字节与归一化字节相同。没有保存 Key、远端文件 ID、原始模型请求或会话日志。没有执行外部进程树采样，不宣称验证了所有后代进程退出。

## 本地测试与审查修正

15项 keyless tests：5项真实 store 测试、2项严格答案测试、8项 loopback 传输测试。覆盖同字节不同名去重、归一化、删除自有cache后重建、收紧写限制仍读旧对象、base64/MIME/batch拒绝及等长损坏拒绝；代理限制访问范围、核对图片hash、拒绝错误答案、保留不确定上传和清理失败的私有所有权信息。

上传返回2xx却缺 ID 的负对照先失败，修正后通过。独立 review 进一步复现502后错误宣布清理完成的问题，补302/408/500/502/504五个 RED/GREEN 用例；现实现对任何无确认ID的转发上传都保守保留不确定状态。第二个 P2 是清理失败后仅在内存持有ID：新增权限0600的原子清单、失败保留与成功删除ID的 RED/GREEN 用例，review 复核通过。

清单在转发前、收到上传ID后和确认删除后按序更新；只保存本次ID及固定endpoint，不含Key。它用于普通失败恢复，不保证强杀窗口或物理掉电一致性。未知ID上传仍不能自动清理；不扩大成账户级删除权限。

添加直接 provider 依赖时重新安装暴露两个本地工具链问题：增量安装产生不可用的peer依赖链接；新解析的 Rolldown `1.2.12` 锁文件缺原生binding条目，Vitest启动失败。重新生成本课安装并将 Rolldown 固定为已验证的 `1.2.11` 后恢复；没有手改 node_modules 或修改 upstream。

## 验证命令

在 `labs/attachment-input` 运行：`pnpm install --frozen-lockfile`、`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`。真实运行通过 `node --env-file=<已有凭据文件> --import tsx examples/live.ts`，exit 0；没有自动重跑。最终15项测试、frozen install、类型/lint/format均通过。9篇变动Markdown的120个相对链接与3个Mermaid图解析通过；21个暂存文件的diff检查通过，凭据模式、已有Key精确值及个人绝对路径命中均为0。独立review的两个P2均修正，最终无剩余P1/P2。

## 仍未覆盖

真实 inline fallback、供应商预算错误/配额清理、EXIF/透明/复杂格式视觉效果、跨机器存储、租户/路径授权、并发清理、物理掉电、Agent强杀恢复与其他平台均未验证。只读重开存储不等于 Agent 冷恢复；模型回答正确不等于任意图片都正确。下一课可用本地受控拒绝 Files 验证整请求 inline fallback，不需要制造真实账户超限。
