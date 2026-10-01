# 真实provider本地图片预算与offload验收

2026-10-01，基线77f3fdd；[课程](../../labs/attachment-input/BUDGET.md)。npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`、macOS arm64、Node26.7.0、pnpm12.3.4、Sharp0.35.5。

## 两组结果

| 模式 | 凭据与endpoint | turn | events | offload | 本地Files501 | 真实Messages |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| reject | fixture-only、本机不可用地址 | 1 error，IMAGE_OFFLOAD_REQUIRED | 12 | 0 | 1 | 0 |
| offload | 已有环境配置 | 2 completed，0tools | 25 | 1 | 3 | 2 |

初次reject验证用现有环境但没有外部请求；最终用fixture Key和127.0.0.1:9重新验证相同拒绝路径。offload真实运行一次，无自动重放。固定2000字节inline预算、quantum1；两张各自能容纳，合计超限。错误来自发布版provider真实字节计算，非fixture手工错误，也非服务端返回。

offload精确选择原消息index0；两轮wire仅含第二张hash。原始两份引用/对象不变，关闭后V4完整事件与显式projection重读一致。恢复场景的首轮颜色答案准确，第二轮只计历史与传输复用。两次最终运行均无远端上传、清理marker为true、exit0，详细[JSON](../../labs/attachment-input/evidence/2026-10-01-budget.json)仅保存元数据。

## 检查与复核

31项keyless测试通过，预算新增5项，其中3个负对照RED后GREEN；类型/lint通过。最终格式、frozen安装、31项测试、类型/lint均通过；7篇变动Markdown的69个相对链接与1个Mermaid图解析通过。独立review无P1/P2，并确认只能报告配置的provider本地预算与真实保留图片请求，不能称为供应商quota错误。

新增官方offload直接依赖时遇到与上一课相同的增量peer链接问题；本课node_modules/lock移入自有ignored scratch后重新安装，最终lock只增加直接依赖条目，没有手改安装包。没有修改upstream或push。

## 全课程范围

本节只关闭“真实provider图片预算计算与持久offload”这一部分。服务端context overflow、stale Files ID恢复、compaction持久化/并发失败、workflow/child/Web剩余场景仍在[全章计划](../superpowers/plans/2026-10-01-complete-chapters.md)内，不因本节通过而勾销。
