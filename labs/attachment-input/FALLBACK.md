# Files 失败后的整请求 inline fallback

本课接续[附件输入](README.md)，固定相同 npm `0.1.7-rc.2` 与 upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。问题是：两张图中有一张无法取得 Files ID 时，另一张是否仍用 Files？已经上传的图片由谁清理？

## 两个受控场景

保持发行版 SDK、附件 store、provider 与真实 Messages endpoint；只在 loopback 测试代理中注入 Files HTTP 501。每个场景独立启动 runtime，用两张随机色块图完成首轮视觉校验和下一轮历史复用，再关闭 runtime、重读附件与V4日志。模型不会获知随机答案。

| 模式                 | 允许转发的上传 | 本地注入                            | 验收要求                                                      |
| -------------------- | -------------: | ----------------------------------- | ------------------------------------------------------------- |
| `reject-all`         |              0 | 所有 Files POST 返回501             | 两轮各2张 inline，0个 Files 引用；无远端上传可清理            |
| `reject-after-first` |              1 | 第一次上传之后的 Files POST 返回501 | 两轮各2张 inline，0个 Files 引用；最后显式清理那1个已确认上传 |

`reject-after-first` 按转发尝试次数限制，不按成功次数放行。若第一次远端上传失败，例子不会放行另一张来补齐“成功数量”；其未确认状态仍遵守上一课的保守清理规则。

本地拒绝记录为 `injectedRejections`；实际转发才进入 `uploads`。这一区别决定了清理：本地已截断的请求没有创建远端文件，而转发后收到501仍可能存在执行不确定性。本课不把两者归为同一种“上传失败”。

## 运行

先按[主教程](README.md#安装与运行)安装并配置已有环境。在 `labs/attachment-input` 中分别运行：

```sh
pnpm live:inline
pnpm live:partial
```

若使用仓库根目录的 `.env`，等价命令为：

```sh
node --env-file=../../.env --import tsx examples/live.ts --files=reject-all
node --env-file=../../.env --import tsx examples/live.ts --files=reject-after-first
```

每条命令包含两次真实模型请求；第二条还允许一次真实 Files 上传。脚本不会自动重放失败的场景。`pnpm live` 保留正常 Files 路径，现在严格要求两轮都使用 Files；要测试 fallback 应明确选择上述模式，避免将意外降级当成正常 Files 验收。

## 固定源码说明

调用链：SDK encoded image → 接纳/归一化 → Session图片引用 → `prepareImages()` → `readImageRequest()` → `prepareFileIds()` → `RequestFiles.resolve()` → `DeepSeekFileStore.ensureUploaded()`。

[RequestFiles.resolve](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/request-files.ts)把未被父请求取消的 Files 解析错误包装为 `FileResolutionFailure`。取消仍传播错误，不能由本课推断取消时也会 fallback。

[DeepSeekAdapter.request](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/adapter.ts)收到这个错误后，把当前请求的 `inline` 置为true，重新序列化全部 retained images。即使前一张已取得 Files ID，重建请求也不会传入那份部分 ID map，因此整条请求都变成 inline。随后仍经过 [inlineImages](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/images.ts) 的 base64 字节/图片数量预算检查；fallback 不等于绕过预算。

`inline` 属于单个模型请求，不是连接级的永久状态。下一轮重新尝试 Files；[ensureUploaded](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/file-store.ts)可复用已保存的第一张映射，再遇到第二张的本地拒绝。因此两个场景都应观察到两次注入，且部分上传场景仍只有一次远端上传。这个内部表示切换与 `retryPolicy.maxRetries` 的 transient retry 不是同一机制；例子将后者设为0。

## 硬断言与负对照

[`verifyTransport()`](src/verify.ts)要求恰有两个成功 Messages 响应，每个包含恰好两张 inline图片、零个Files引用，顺序/hash与独立重读的请求版本一致；上传数量、确认状态、被拒绝图片的hash和拒绝次数也必须匹配所选场景。模型答案准确但字节不匹配，仍然失败。

keyless 测试先观察到缺失行为，再实现：代理注入测试最初得到200而不是501；验收器的负对照最初没有拒绝混用、图片调序/改字节、缺少注入/额外上传、上传未确认/模型响应失败。修正后这些用例通过。另加远端404/501的清理不确定性回归，确保不会把真实错误响应当成本地“未转发”。

第二轮文本历史已经包含首轮答案，所以两个场景合计是两份独立双图视觉样本，外加两次历史/传输复用检查；不能宣称4份独立视觉样本。

## 清理与适用范围

provider 的 fallback 不保证回收已经上传的对象。本课代理继续记录本次所有权，部分上传场景的文件由脚本在验证后显式删除。不得将“请求最终改用 inline”解释成“从未上传”或“远端文件已自动删除”。失败保留0600的私有清理清单和脱敏传输证据，处理方式见[主教程](README.md#清理与失败处理)。

真实结果与计数见[验收记录](../../docs/reviews/2026-10-01-attachment-fallback.md)。这些是“本地受控 Files 失败 + 真实 inline Messages”的证据，没有制造或验证供应商真实宕机、账户超限、上传响应丢失、stale ID、真实预算错误或强杀恢复。下一课[图片预算与持久offload](BUDGET.md)使用固定版provider的小预算配置验证拒绝和恢复，继续与真实供应商超限区分。
