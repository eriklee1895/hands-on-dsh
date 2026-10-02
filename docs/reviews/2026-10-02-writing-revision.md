# 全章节写作修订与验证

执行窗口：2026-10-02 至 2026-10-03，Asia/Shanghai。

本轮从 `dc26b577416e4d393f687530894f8ca9a82f6b4f` 继续，落实[全章节写作审查](2026-10-02-writing-review.md)。修改 74 个已有教学与导航 Markdown，另改 FastAPI 两个静态文件的阅读链接和同进程会话文案。runtime、SDK、锁文件、测试实现和模型配置均未改变。

## 读者会看到什么变化

首页现在先帮助读者选路线和运行例子。Python/FastAPI 明确采用“运行完整示例，再拆解代码”的方式，每章补观察、输出解读或小练习；TypeScript 四例从简短索引展开为逐例讲解。两个完整项目串起任务提交、状态判断、断连重放、产物下载与恢复。

七篇机制章先描述一个具体问题，再沿执行关系解释，固定源码表放在查证位置。Session 章用 seq 前后对照解释 surface；Cordis 从依赖消失与恢复讲 effect；观测课按实际 fixture 逐事件演算费用；故障实验明确区分调用方结果、持久事实与外部状态。日期、真实负面观察和未覆盖范围仍保留。

原 Python 路线中的 2026-08-31 运行细节移到[历史记录](2026-08-31-python-app-history.md)，未改写为新成绩。历史机制 probes 和其他既有验收报告保持原内容。

## 审查项落实

| 审查项 | 修订结果 |
| --- | --- |
| F1 · Python Session 恢复 | 双语第二章明确只验证存活进程内复用，保留 home 不等于 stock SDK 自动 resume |
| F2 · env 加载 | 十二篇 Python 章节的主运行块显式加载根 `.env`；已 export 凭据的备选命令另行说明 |
| F3 · FastAPI 阅读入口 | 五章按钮明确标为“在 GitHub 阅读本章”，新标签链接到对应渲染文档；没有增加本地渲染依赖，阅读需要联网 |
| F4 · Web 操作顺序 | 基础课与恢复课均指明 Host/操作终端的变量；停机验收后复用同一 root 重启；admission 与 concurrent 按单向顺序执行 |
| F5 · 图示语义 | receipt 是活动起点；压缩器、模型、工具执行器、Session 与文件的职责分开；取消后的迟到提交单独解释 |
| F6 · Adapter 生命周期 | 显式区分 DSH 成功后复用/close 等待操作与 CLI 一次任务/close 终止回收 |
| F7 · 过期状态 | 当前版本、项目 adapter 与已完成实验链接同步；带日期的历史成绩仍保留原范围 |
| F8 · 命令目录 | 修正五处“本目录”与重复 cd 矛盾，明确 AG-UI 开发模式的两个终端和端口 |
| F9 · 术语与限定 | token 长度用字符计；补租户实验收尾；工具投影不再暗示通用脱敏保证 |

独立复核另指出 Web 基础课的 Host 终端未设置 `LAB_ROOT`：已补同一目录赋值，最终验收也明确切回保存 `SESSION_ID` 的操作终端。AG-UI 的 owner marker 权限同时按实现校正为 0600，所属目录为 0700。

## 图表与阅读入口

现有与新增图合计 69 张 Mermaid，较原来的 44 张增加 25 张。拆分宽图并缩短标签后，在本地 Mermaid 11.16.0 的统一渲染中全部成功，最大原始宽度为 949px；原来的 14 张超过 1200px 的图已重排或拆分。此测量限定本地浏览器与字体环境，不代表所有 Markdown 平台都采用完全相同布局。

Inbox、overflow recovery、child forest 和 AG-UI 重放四张复杂时序图另有约 110KiB 的独立 SVG 导出链接，供小屏放大。Mermaid 仍是可编辑原图；后续修改相关图时需同步导出 SVG。简单字段映射与 usage 演算采用表格，未用装饰插画代替机制解释。

[进程池重排后的阅读尺寸](assets/2026-10-02-writing-review/pool-after.png) · [FastAPI 375px 阅读入口](assets/2026-10-02-writing-review/fastapi-link-mobile.png)。前者是独立审图画廊，后者使用当前应用与 Fake runtime；两者均不代表真实模型运行。

FastAPI `/chapter/1` 至 `/chapter/5` 已在真实本地浏览器逐页核对：文本、对应 GitHub 路径、`target="_blank"`、`rel="noopener noreferrer"` 正确。375px 下阅读链接可见。外网 GitHub 的本次渲染未复验；未发布的本地改写也不会提前出现在远端 main。

## 本轮执行的检查

| 检查 | 结果与范围 |
| --- | --- |
| FastAPI app 与文档测试 | 10 passed，使用当前源码/测试和既有 Python 环境，Fake runtime |
| Python 双语与文档入口测试 | 3 passed、16 deselected；仅选择受改写影响的文档检查 |
| JavaScript 语法 | `node --check` 检查 FastAPI `static/app.js` 通过 |
| 全仓相对文件及本地锚点 | 见下方最终计数；无缺失目标或锚点候选 |
| 改动文档中的 shell 代码块 | 155 个通过 `bash -n`；这是语法检查，不是运行所有命令 |
| 图表 | 69/69 浏览器渲染通过，无超过 1000px 的图；独立 SVG 已查看并按对应 Mermaid 同步 |
| 文本与文件检查 | `git diff --check`、恰一尾换行、凭据模式/已知凭据/个人绝对路径扫描通过 |

最终文档计数：141 篇 Markdown、798 个相对文件链接、69 张 Mermaid；相对文件与本地锚点检查均无问题。

测试使用既有 worktree 的虚拟环境加载当前 checkout 的源码和测试，没有安装新依赖。精确选择为：

```sh
# 当前仓库根目录；python 为已安装这些锁定依赖的现有解释器
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$PWD/tutorials/fastapi-101/src" \
  python -m pytest -p no:cacheprovider -c tutorials/fastapi-101/pyproject.toml \
  tutorials/fastapi-101/tests/test_app.py tutorials/fastapi-101/tests/test_tutorials.py

PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider \
  -c tutorials/python-sdk/pyproject.toml tutorials/python-sdk/tests/test_demos.py \
  -k 'bilingual or tutorial or documented_entrypoint'

node --check tutorials/fastapi-101/src/dsh_fastapi_101/static/app.js
git diff --check
```

首次文档检查遇到两个旧格式约束：Python 检查还要求 bare `uv run` 入口，FastAPI 检查禁止章节中的任意 `../`。最终保留真实可用的 shell-export 备选说明，并在 FastAPI 章节用 Git 定位根 `.env`；没有删弱测试来获取通过。

本轮没有调用付费模型、重跑 Docker 或完整 runtime 测试，也没有把文档示意输出写成新实跑。独立审查覆盖全部 76 个已跟踪文件的改动和历史内容迁移；两个复核发现修复后再次核对，F1–F9 无剩余缺口，未留下可操作的问题。验收完成时修改仍在本地；后续提交与 PR 状态以 Git 历史和 GitHub 记录为准。
