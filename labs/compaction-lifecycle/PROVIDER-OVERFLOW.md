# 一次真实服务端 context overflow

前面的[溢出与取消](RECOVERY.md)能稳定走到每条恢复分支，但错误由受控 adapter 提供。这里换成一个更窄的问题：真实服务端拒绝过长输入后，发布版 provider 能否把它识别为 `CONTEXT_WINDOW_EXCEEDED`，并把失败写进持久日志？

本课只验证这条错误路径，不加载压缩恢复插件。npm 固定 `0.1.7-rc.2`，源码仍为 `477b4f420553e8a52c2fbccc464d7561b239c443`。

## 有界实验

`examples/provider-overflow.ts` 只提交一次请求：固定110万份 `x ` 加短指令，prompt总计2,200,104字节；这不是完整HTTP请求体大小。模型为已有 `deepseek-flash`，reasoning off、maxTokens16，transient重试0；禁用SDK minimal的Bash/Pwsh工具，不加载compaction恢复插件。180秒活动deadline触发后关闭owner，不自动重放。

为了让请求到达服务端，实验把本地 catalog 的 `contextWindow` 声明为 4,000,000，高于这次服务端能接受的输入。这个设置只改变客户端的容量说明，不能增加服务端容量，也不是生产配置建议。110 万份片段同样不是实际服务端 tokenizer 测得的 token 数。

在本Lab目录，有已有凭据时运行：

```sh
pnpm overflow:provider
# 或根目录被忽略的.env：
node --env-file=../../.env --import tsx examples/provider-overflow.ts
```

运行结果有一个容易误读的地方：**实验通过时，Agent 任务应当失败**。预期报告同时出现一次远端拒绝和一个 canonical overflow 终态；脚本 exit 0 表示验证到了预期错误，不表示模型完成了任务。

这是较长的真实请求，脚本只接受一次实际拒绝。若服务端今后接受它，实验必须失败并保留证据，不会自行增大输入或继续压测。

## 验证标准

复用[附件Lab的loopback观测代理](../attachment-input/src/transport.ts)，仅转发到已有配置的endpoint。本课不注入HTTP错误，不发送图片，也不修改模型请求字节。成功验收必须同时满足：

- 代理看到唯一一次Messages请求，远端HTTP400或413；没有“只在客户端失败却没有外部请求”的情况。
- DSH的turn结束为error，canonical code为 `CONTEXT_WINDOW_EXCEEDED`。AUTH、INVALID_REQUEST、网络错误等都不算通过。
- 最终模型正文为空、工具调用为0；不会把SDK `run()` 返回误认为业务成功。
- 关闭后重开V4，原长输入和全部现场事件一致；只在报告中导出输入hash/字节数和白名单状态，不提交原Session。

为什么既检查 HTTP 状态，又检查 DSH 错误码？HTTP 400 也可能来自其他无效参数。固定版[错误分类器](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/transport.ts)先检查 context-window 含义，再处理一般 invalid request。代理证明请求确实到达了远端，canonical code 则证明 DSH 将这次拒绝识别成了上下文溢出。

## 实际观察

2026-10-02一次运行返回HTTP400、`CONTEXT_WINDOW_EXCEEDED`；0个成功模型响应、0次工具调用、12个完整V4事件与现场相同，输入SHA-256为 `83a2f6f3db1e8581634a42cd20ff8997e123dc4ea67eb6da5c554fa48f4335d7`。临时目录已删除，exit0。详见[元数据](evidence/2026-10-02-provider-overflow.json)与[验收](../../docs/reviews/2026-10-02-provider-overflow.md)。

本课不根据这一错误反推精确token上限、价格或未来模型容量，也没有验证“服务端真实溢出→真实摘要→成功重试”的完整组合；自动恢复分支的证据仍由受控实验拥有。图片的本地字节预算则属于[另一课](../attachment-input/BUDGET.md)，不要混为同一种失败。

失败时保留自有目录并报告关闭状态。即使保存传输元数据失败，也要关闭代理listener；该失败路径通过真实临时目录和本地listener负对照验证。远端请求不会因本地证据保存失败而自动重发。
