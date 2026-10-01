# SSE 与 WebSocket：先看事件何时产生

本章比较本仓库两个已运行的方案：自有AG-UI应用的HTTP/SSE，和固定DSH `0.1.7-rc.2` 官方Web的HTTP/Remote WebSocket。传输选型需要同时看控制入口、数据产生时间、订阅生命周期和恢复来源；仅把连接换成WebSocket不会增加上游缺失的live token。

## 两条真实链路

| 维度 | 自有AG-UI项目 | 官方DSH Web |
| --- | --- | --- |
| 命令提交 | HTTP POST `/api/ag-ui` 与业务API | HTTP POST unary，例如 `/api/session/prompt` |
| 下行 | AG-UI SSE；独立业务cursor SSE | `/api/remote.mux` WebSocket中的logical streams |
| 文本粒度 | stock SDK的已提交assistant文本 | 独立live assistant-stream + 持久事件 |
| 恢复依据 | SQLite RunEvent、业务状态与Artifact | Host Session历史、订阅generation与runtime状态 |
| 已实测断开行为 | AG-UI detach后Run继续，业务游标可回读 | 浏览器离线后历史恢复；正常Host重启后同Session续写 |
| 限制 | 当前项目没有wire cancel/approval | 每项GUI控制仍需按固定版实际验证 |

SSE是服务器向客户端推送的事件流；应用把提交/审批等控制放在独立HTTP请求上即可形成双向业务交互。WebSocket可以在同一连接上承载双向消息，但官方Web在这里仍将unary控制放在HTTP上。不要从协议支持双向通信推断产品把全部控制都放进了同一条socket。

## SSE示例的两个出口

[服务端路由](../../projects/ag-ui-dsh-runtime/src/server/app.ts)让POST `/api/ag-ui` 输出AG-UI编码的SSE；`GET /api/runs/:id/stream` 输出业务事件游标流，另有 `GET /api/runs/:id/events` 提供有界分页。消费方必须按该出口的实际cursor规则恢复，不能把DSH Session seq或AG-UI messageId代入业务游标。

[`subscriptions.ts`](../../projects/ag-ui-dsh-runtime/src/server/subscriptions.ts)从SQLite已保存的事件开始，再等待后续通知。断开的HTTP响应释放订阅，并不拥有Run取消权。持久状态与外部产物仍由coordinator/store确认。

## WebSocket示例的multiplex与generation

固定版官方Gateway在一条Remote socket上管理logical streams；Host先安装增量监听并发送ready；Client收到ready后才发布该generation与connected状态。断开使该generation失效，旧source清理后才替换。源码入口及版本见[协议与Web Host机制章](../../how-dsh-works/07-sdk-jsonrpc-acp-and-web-host.md)，不要套用旧版 `/api/events.mux` 的说明。

[官方Web运行课](../../labs/web-host-lifecycle/README.md)使用浏览器帧观察证明：两条回复各有4个独立text-delta先于对应的durable assistant/message。这是该固定版本和短样本的观察，不是固定帧数、吞吐、延迟或网络性能保证。

## 从需求推导实现

依据上述两个案例，可作以下设计判断：

- 自有业务服务需要持久Run与断线游标时，可先沿用现有HTTP提交与SSE下行；最先补的是业务状态、游标和幂等规则，而不是改传输。
- 消费官方GUI实时能力时，应使用该版本实际提供的Remote streams，并处理generation替换；stock SDK没有的live token不能靠给它套一层WebSocket补出来。
- 要支持取消或审批时，先定义其身份、目标请求、终态和迟到回答规则，再接入具体控制方法。关闭SSE、断开socket和取消Agent是三种不同操作。

这些是本仓库案例导出的判断，不是所有应用的性能选型结论。这里没有SSE/WebSocket吞吐基准，也没有跨平台网络丢包矩阵。

## 怎么验证

先跑[AG-UI项目的keyless server/browser流程](../../projects/ag-ui-dsh-runtime/README.md)，再跑[官方Web Lab](../../labs/web-host-lifecycle/README.md)。验收应观察提交是否被接纳、首个live帧何时出现、durable终态何时保存、断开后任务/文件是否变化，以及重连从哪里恢复。

本章复用[AG-UI验收](../reviews/2026-09-29-plugin-agui-internals.md)、[Web实时帧/重启验收](../reviews/2026-09-30-web-host.md)和[取消/离线验收](../reviews/2026-09-30-web-controls.md)。没有为了比较传输而重发模型任务，也未将这些旧日期的运行算为新的一次E2E。
