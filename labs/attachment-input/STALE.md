# 已删除 Files ID 的重新上传与恢复

本地还记着一个 Files ID，供应商那边的文件却已经被删除，下一次请求会怎样？这与前一课“上传失败”的时点不同：ID 已经取得，请求也真正发到了 Messages endpoint，错误来自服务端对旧引用的拒绝。

本课主动删除自己刚上传的一张图片，再把仍含旧 ID 的 Messages 原样转发，观察 provider 能否用保留的本地字节重新上传。固定 npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。前置为[附件输入](README.md)与 [fallback](FALLBACK.md)。

## 运行

在 `labs/attachment-input`，已有环境凭据时：

```sh
pnpm live:stale
```

使用根目录被忽略的 `.env`：

```sh
node --env-file=../../.env --import tsx examples/live.ts --files=stale-once
```

运行前先留意故障注入的顺序：上传两张图 → 等待第一张的 DELETE 确认 → 发送仍含旧 ID 的请求。如果未等删除确认就发送，请求可能仍然成功，便没有验证到 stale 恢复。

代理只处理本次记录的 ID，不扫描账户文件，也不删除其他任务的对象。删除的是远端对象；该图的本地归一化文件与请求版本仍保留，恢复时就从这里取得重新上传的字节。

## 实际调用序列

2026-10-01实测：

1. 两个Files上传均成功；代理记录各自的字节hash与私有ID。
2. 代理确认删除第一张，然后原样发送包含两个Files引用的Messages；服务端返回HTTP400。
3. 发布版provider识别失效引用，重新上传第一张；第二张映射仍被复用。
4. 重建的Messages使用两个有效Files引用，返回HTTP200；首轮颜色答案准确。
5. 同Session下一轮再次使用这两张图，返回HTTP200；没有新增上传。
6. 关闭runtime并独立核对V4的22个事件、附件字节与请求版本。清理其余两个自有上传，删除总数为3，临时目录删除。

详细[元数据](evidence/2026-10-01-stale.json)与[验收记录](../../docs/reviews/2026-10-01-attachment-stale.md)保留状态和hash，不保存Key、远端ID或原始错误体。两轮均completed、0次工具调用。第二轮仍只计历史复用，不是独立视觉样本。

## 固定源码说明

为什么本次只多了一次上传？[RequestFiles.retry()](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/request-files.ts)先识别错误文本中的失效 Files 含义。如果详情准确点名第一张的 ID，就只失效这份映射，第二张继续复用；如果错误没有明确 ID，就失效本次使用的候选映射。

`retried` 将同一请求的修复机会限制为一次。这是固定源码的规则；本课真实运行只触发了一次修复，没有测试连续两次失效。

[adapter](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/adapter.ts)收到允许修复的结果后重新组装请求。[file-store](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/file-store.ts)在已失效映射缺失时，使用相同request variant字节重新上传。它不会重新让模型识别或生成图片。

本次观察到3次上传，符合只修复第一张。验收器也接受“通用错误导致两张都重新上传”的4次上传序列，但后者只有keyless数据测试，没有本次真实服务端证据。两条路径均必须保持原始图片的字节hash与次序。

## 验收与限制

[`verifyTransport()`](src/verify.ts)要求一条HTTP400/404失败请求、恰好一次自有ID删除注入、两条后续HTTP200、三条请求均为2 Files / 0 inline，且重传字节与原图匹配。没有初始失败、没有受控删除、修复了不同字节或多出请求均不通过。最终脚本要求确认删除数等于本次上传数。

当次 35 项本地测试通过：测试检查删除确认发生在 Messages 之前，并用两种映射失效范围验证上传计数；负对照会拒绝缺少初始失败、字节变化或多出请求的“恢复成功”。实现过程中的失败记录见前面的验收链接。默认的保守上传清理、权限限制和私有清单继续生效。

这验证了主动删除自有文件后的真实拒绝与恢复，不是自然expiry、用户更换账户、并发映射竞争、两次连续失效或进程强杀。fallback与stale恢复也不同：前者在Files解析失败时改成全inline；本次一直使用Files，只替换了失效的远端ID。
