# Inline 图片预算与持久 offload

本课使用真实发布的 `llm-deepseek` provider 和 `compaction-image-offload` 插件，固定 npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。接续[整请求fallback](FALLBACK.md)：当Files被本地拦截、两张inline图片超过预算时，如何验证拒绝和恢复？

## 配置及对照

两张512×512色块图仍先通过生产store归一化为256×256JPEG。本课把 `maxInlineRequestImageBytes` 设为2000、`inlineImageOffloadByteQuantum` 设为1；实际断言每张图片的base64字节数都不超过2000，而两张之和超过2000。计数是 `4 × ceil(encodedBytes / 3)`，不是整个JSON请求体大小。

| 模式      | 插件            | 预期                                                     |
| --------- | --------------- | -------------------------------------------------------- |
| `reject`  | 不加载offload   | turn以 `IMAGE_OFFLOAD_REQUIRED` 错误结束，无Messages请求 |
| `offload` | 加载官方offload | 记录最旧图片index0，重试只发第二张；下一轮仍只发第二张   |

Files使用 `reject-all` 的本地501，不转发任何上传。预算错误由真实provider在Messages发送前计算得出，不是fixture手工抛出，也不是供应商返回的quota错误。

## 运行

在 `labs/attachment-input`：

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

拒绝对照不需要真实Key。将endpoint设为不可用的本机fixture地址，正确执行时不会访问它：

```sh
DEEPSEEK_API_KEY=fixture-only DEEPSEEK_BASE_URL=http://127.0.0.1:9 pnpm budget:reject
```

恢复对照会调用两轮真实模型，需要已有凭据：

```sh
pnpm budget:offload
# 或根目录已有被忽略的.env：
node --env-file=../../.env --import tsx examples/live.ts --files=reject-all --budget=offload
```

恢复模式的prompt要求只描述仍可见的图片，忽略offload占位符，不调用工具。父进程只接受第二张的准确颜色顺序。后续轮次已经有首轮文本答案，只作为持久选择与传输复用检查。

## 执行链与验证

[provider的 `inlineImages()`](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/images.ts)计算base64预算，发现需要移除一个最旧occurrence时返回带 `offloadImages` 的错误。没有恢复插件时，Agent结束为error；SDK的 `run()` 仍可能正常返回一个RunResult，因此必须检查 `turn/end.reason`，不能把Promise兑现当成成功。

[官方offload插件](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/compaction/compaction-image-offload/src/index.ts)在 `agent/request-error` 记录 `image/offload` 后请求retry。选择是“原消息seq + imageIndexes:[0]”，不会删除或改写原图片引用。错误处理属于持久输入缩减，不是 `retryPolicy.maxRetries` 的transient重试；本课该值仍为0。

硬断言包括：

- 拒绝模式：恰有1个error turn，code为 `IMAGE_OFFLOAD_REQUIRED`；0个offload、0个Messages。
- 恢复模式：恰有1条offload，准确指向初始消息的index0；两个turn completed，0个工具调用。
- 原消息仍保存两张原始引用；显式 `imageOffloadProjection` 重放后，只标记第一张，attachment字段与顺序不变。
- 两轮实际wire都只有第二张inline图片，hash与独立重读的请求版本一致；两份durable对象仍可读。
- runtime关闭后新Context重开V4，全部事件相等；恢复模式的projection也一致。

## 实测结果

2026-10-01：拒绝模式12个持久事件、1次本地Files501、0个模型请求；恢复模式25个事件、1条offload、3次本地Files501、2个HTTP200 Messages，每个只含1张inline图片。第三次501属于下一轮重新尝试Files。两模式无远端上传、无远端删除，临时目录均已清理。

31项本地测试通过，预算验收新增5项，负对照拒绝“预算失败却发送模型请求”“省略新图或下一轮恢复旧图”“没有首次失败尝试却宣称恢复”。详细结果见[元数据](evidence/2026-10-01-budget.json)与[验收](../../docs/reviews/2026-10-01-attachment-budget.md)。

本课没有触发服务端context overflow、账户配额错误、真实网络丢响应、图片质量评测或强杀恢复。它补齐生产store与真实provider预算计算相连的路径，不能替代[前一组受控compaction故障](../compaction-lifecycle/REDUCTION.md)的其他场景，也不把本地配置造成的错误写成供应商故障。
