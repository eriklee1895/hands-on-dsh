# 附件整请求 inline fallback 验收

日期：2026-10-01；基线 `3e82f05`。新增[Fallback课](../../labs/attachment-input/FALLBACK.md)，沿用 npm `0.1.7-rc.2` / upstream `477b4f420553e8a52c2fbccc464d7561b239c443` / Sharp `0.35.5`。macOS arm64、Node `26.7.0`、pnpm `12.3.4`。

## 实际结果

两次独立 `sdk-minimal` profile 运行使用现有凭据，各有两张随机色块图与两轮真实模型调用。Files 失败由本地代理在转发前注入HTTP501；Messages仍发送给真实endpoint。不是供应商真实故障或超限实验。结果元数据见[JSON](../../labs/attachment-input/evidence/2026-10-01-fallback.json)。

| 场景 | 本地501 | 真实上传 / 删除 | Messages | V4完整事件 |
| --- | ---: | ---: | --- | ---: |
| 全部上传拦截 | 2 | 0 / 0 | 2个HTTP200，每个0 Files + 2 inline | 22 |
| 第一张上传后拦截 | 2 | 1 / 1 | 2个HTTP200，每个0 Files + 2 inline | 22 |

每轮传输中的两张图，其解码后hash及次序都与关闭runtime后独立store读取的请求版本一致。两场景的首轮视觉答案精确匹配各自随机真值，后续轮次也匹配；所有turn均completed，工具调用为0。两图均从512×512 PNG归一化为256×256 JPEG，本批每组分别为1307和1320字节。

两次运行各重新生成图像；4份输入中有3种不同的source hash，一张图偶然重复。第二轮可复用首轮文本答案，因此本批是两份独立双图视觉样本，加两次历史/传输复用检查。模型调用总计4次，不能包装成4份独立视觉评测。

部分上传场景的已确认ID不写入提交证据，保留于私有临时状态，验证后显式删除。两次运行均打印 `localTemporaryDirectoryRemoved: true`，exit 0，没有自动重跑或保留失败目录。没有外部进程树采样，也没有验证异常断电。

## 机制与失败区分

固定版 `RequestFiles.resolve()` 将未被父请求取消的解析错误包装；adapter 改用inline重新序列化整条请求，不保留部分Files引用。下一次模型请求从Files尝试开始，已成功上传的映射可复用；此次观察为每个场景两次注入，部分场景始终只有一次真实上传。`retryPolicy.maxRetries: 0` 不关闭这一表示切换。

新增 `injectedRejections` 与 `uploads` 两套计数：前者在本地截止，不产生远端所有权；后者若没有确认ID，仍视为清理不确定。远端HTTP404/501不能因为与本地注入状态相同就被认作未执行。

清理不由fallback自动承诺。本课仍通过私有清单、ID访问限制和显式DELETE处理本次已创建对象；错误响应不扩大成账户级文件清理。

## 验证与复核

- keyless：26项通过。保留原15项；新增2个转发上限场景、远端404/501两项不确定性回归、7个模式/验收器测试。
- RED/GREEN：两个注入用例最初返回200而非501；四个负对照测试最初未拒绝混用、错误hash/次序、缺少注入/额外上传、未确认上传/失败响应，随后修复并通过。
- frozen install、严格类型、lint与format通过。8篇变动Markdown的128个相对链接与2个Mermaid图解析通过；暂存diff及凭据检查通过。
- 实跑命令：在 `labs/attachment-input`，使用已有凭据分别执行 `node --import tsx examples/live.ts --files=reject-all` 和 `--files=reject-after-first`，两者exit 0。
- 实跑前和最终独立review均无P1/P2；最终复核确认了字节、计数、清理与证据范围。

默认 `forward` 模式现在严格要求两轮全部Files；本批没有重复真实正常Files运行，正常模式的真实证据仍是[上一课](2026-10-01-attachment-input.md)。本批本地回归包含正常模式的验收数据与原代理转发/清理路径。没有修改DSH upstream或push。

## 未覆盖

供应商真实故障、配额清理、请求发送后响应丢失、stale ID恢复、真实inline预算错误与offload、并发/强杀恢复、其他平台均未验证。下一步优先做小预算的受控provider实验，明确区分本地预算拒绝与真实供应商超限响应。
