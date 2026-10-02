# 已删除 Files ID 的重新上传与恢复

本课固定 npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443`。前置：[附件输入](README.md)与[fallback](FALLBACK.md)。实验主动删除自己刚上传的一张图片，然后把原Messages请求原样转发，观察真实服务端拒绝及provider恢复。

## 运行

在 `labs/attachment-input`，已有环境凭据时：

```sh
pnpm live:stale
```

使用根目录被忽略的 `.env`：

```sh
node --env-file=../../.env --import tsx examples/live.ts --files=stale-once
```

该模式先上传两张图，在第一条Messages转发前等待第一张的DELETE确认，再发出仍含旧ID的原始请求。它只处理代理记录的本次ID，不扫描账户文件，也不删除其他任务的对象。被删除图的本地归一化文件与请求版本仍保留，可用于重新上传。

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

[RequestFiles.retry()](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/request-files.ts)基于错误文本中的失效Files含义处理已使用的映射。若详情准确命名ID，失效对应映射；没有明确ID时，失效本次使用的候选映射。`retried` 限制同一请求的修复机会；这属于源码事实，本课实跑只触发一次修复。

[adapter](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/adapter.ts)收到允许修复的结果后重新组装请求。[file-store](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/llm/llm-deepseek/src/file-store.ts)在已失效映射缺失时，使用相同request variant字节重新上传。它不会重新让模型识别或生成图片。

本次观察到3次上传，符合只修复第一张。验收器也接受“通用错误导致两张都重新上传”的4次上传序列，但后者只有keyless数据测试，没有本次真实服务端证据。两条路径均必须保持原始图片的字节hash与次序。

## 验收与限制

[`verifyTransport()`](src/verify.ts)要求一条HTTP400/404失败请求、恰好一次自有ID删除注入、两条后续HTTP200、三条请求均为2 Files / 0 inline，且重传字节与原图匹配。没有初始失败、没有受控删除、修复了不同字节或多出请求均不通过。最终脚本要求确认删除数等于本次上传数。

35项本地测试通过，包含“删除发生在Messages前”的RED/GREEN、两种映射失效范围的验收，以及错误恢复声明的负对照。默认的保守上传清理、权限限制和私有清单继续生效。

这验证了主动删除自有文件后的真实拒绝与恢复，不是自然expiry、用户更换账户、并发映射竞争、两次连续失效或进程强杀。fallback与stale恢复也不同：前者在Files解析失败时改成全inline；本次一直使用Files，只替换了失效的远端ID。
