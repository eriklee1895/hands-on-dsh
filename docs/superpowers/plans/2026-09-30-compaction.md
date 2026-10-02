# Compaction evidence implementation plan

> **For agentic workers:** Use dispatching-parallel-agents for independent engine tests and live verification/docs. TDD and independent review required.

**Goal:** 补齐机制篇05的新版压缩执行证据。

**Architecture:** 发布engine+fixtureadapter -> 公开SDK pressure+real summarizer -> 持久session重读与surface折叠+精确artifact。

**Tech Stack:** TS strict NodeNext、DSH0.1.7rc2/Cordis4.0.4、pnpm12.3.4/Vitest。

- [x] 固定源码审查与锁定依赖。
- [x] 确定性engine成功/no-op/summary失败/后续请求验证。
- [x] 真摘要trigger/bracket/checkpoint/原始记录和实际artifact验证。
- [x] 独立review，补充正文、导航、报告，检查后本地commit。

保持既有worktree和提交授权，不push；workflow-ptc/child cold resume仍待后续。
