# Plugin tree 与 runtime 组装：profile、preset 与可逆 lifecycle

> 固定版本：`dsh-v0.1.7-rc.2`；revision：`477b4f420553e8a52c2fbccc464d7561b239c443`；源码审查：2026-09-29。

本篇区分三种组合：profile 决定进程加载什么，preset 决定 Agent 可见的工具和提示词，Cordis fiber 决定资源何时激活与撤销。preset 不提供操作系统安全隔离。

## Verified from source

| 入口 | 职责 |
| --- | --- |
| [CLI bin](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/cli/src/bin.ts)、[profile runner](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/apps/cli/src/profile-boot.ts) | 公开 `dsh --profile` 启动和有序 patch 组装 |
| [profile](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/profile.ts)、[boot](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/boot/app-boot/src/index.ts) | shipped templates、解析 bundle、Loader 与激活检查 |
| [preset registry](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/src/index.ts)、[mount](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/packages/preset/agent-preset-registry/src/mount.ts) | 声明修订、作用域树、Agent 绑定与激活审计 |
| [Cordis fiber](https://github.com/deepseek-ai/deepseek-harness/blob/477b4f420553e8a52c2fbccc464d7561b239c443/vendor/cordis/src/fiber.ts) | 可逆 effect 的生命周期与清理 |

### profile 与 bundle

公开 Node 应用经 `dsh --profile <name>` 或 `dsh <name>` 启动。`web`、`headless`、`sdk`、`acp` 都以 base bundle 为第一层；`sdk-minimal` 是独立完整 bundle，**不叠加 base**。TypeScript SDK 默认解析同版本 dsh 并选择 sdk；自定义能力通过 profile 和 patches 组合，不通过任意 `launch.command/args`。

profile manifest 的 `dsh.profile.bundles` 按顺序引用 bundle；bundle 的 `dsh.bundle.patch` 指向配置补丁。最终配置从空 entry list 开始，依次应用 bundle patches、profile 自己的 patch、home-level patch、命令行 `--patch`。按 id 覆盖一行时替换完整 config，不能假定对象字段深合并。

`runProfile()` → profile 准备与加载 → `boot()` → root Context / Loader / Include → entry 导入 → fiber 激活。`inject` 依赖缺失时 fiber 等待，服务可用后才运行 plugin；boot 等待 Loader 并检查启用 entry 的激活结果。配置行相邻不意味着串行启动。`--dump-config` 只显示组合结果，不能证明服务激活，也不执行依赖就绪后才求值的 `!!js`。

### preset 与 Agent scope

`@deepseek-ai/dsh-agent-preset` 是普通声明行，其 `config.id` 与 `plugins` 由 preset registry 管理。registry 的 `default` 指定未显式选择时的 preset；它不扫描任意 preset 路径。每个声明修订建立 registry-owned scope 与 Loader tree，Agent scope 通过父链接取得可见贡献。

更新或删除声明会退休旧修订。已有 Agent、child 和历史读取引用仍保留它，最后一个引用释放后才卸载；新绑定使用当前声明。重启只恢复持久化的 preset ID，再解析**当前**定义；不承诺恢复旧进程中的实现修订。缺失定义与激活失败阻止绑定。preset 中的 service row 需要正确 `isolate` realm，不能把服务意外注册到全局。

```mermaid
flowchart TD
    P["profile + ordered patches"] --> L["Loader / dependency activation"]
    L --> H["Host services"]
    L --> D["preset declarations"]
    D --> R["revision-owned plugin scope"]
    R --> A["Agent scope and visible contributions"]
    A --> E["listeners / tools / prompt sections"]
    E --> X["dispose owned effects"]
```

`ctx.on()`、`ctx.effect()` 与 effect-aware register 管理撤销。依赖丢失、reload 和 owner disposal 都必须沿资源所有权处理；自己挂在全局的 timer/listener 不会因为它曾由 plugin 创建就自动归属 fiber。

## Observed at runtime

[2026-09-28 supervisor 执行记录](../docs/reviews/2026-09-28-execution.md)记录发布 `0.1.7-rc.2` 的 sdk-minimal initialize/close 成功；它只支持“公开 profile 可启动”，不证明所有 profile、preset 修订或 HMR。新版 Cordis 的进一步证据由 [lifecycle lab](../labs/cordis-plugin-lifecycle/README.md)独立拥有。

本篇本次没有重跑 profile/preset 行为测试。[2026-08-31 composition probe](historical-2026-08-31.md)为历史证据，不能沿用为新版结果。

## 最小核对与限制

在具有该 tag 的 upstream checkout 中执行（只读，不要求 checkout master）：

```sh
git show dsh-v0.1.7-rc.2:packages/boot/app-boot/src/profile.ts
git show dsh-v0.1.7-rc.2:packages/preset/agent-preset-registry/src/mount.ts
```

这是可重复的源码核对，不是运行验收。Inference：诊断未激活 plugin 时依次核对最终 entry、导入错误、缺失 service 与 preset scope。Proposal：在独立 lab 再验证修改声明后旧 Agent 保留修订、新 Agent 使用新修订；本篇未验证这一热更新路径，也未验证 Windows resolution 或 sandbox。
