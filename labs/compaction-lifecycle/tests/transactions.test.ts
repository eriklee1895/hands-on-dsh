import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Llm from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Agents from "@deepseek-ai/dsh-agent";
import Loop from "@deepseek-ai/dsh-agent-loop";
import Meter from "@deepseek-ai/dsh-token-meter";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { runTransactionScenario, TRANSACTION_SCENARIOS } from "../src/transaction-scenarios.ts";
import { verifyReplay } from "../src/replay-evidence.ts";
it.each(TRANSACTION_SCENARIOS)(
  "records %s without claiming rollback or a second owner",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "compaction-transaction-"));
    const ctx = new Context();
    try {
      for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents])
        await ctx.plugin(plugin);
      await ctx.plugin(Persistence, { root, compression: "none" });
      await ctx.plugin(Loop, { agents: [] });
      await ctx.plugin(Meter);
      await ctx.plugin(BasicCompactionEngine, {
        auto: false,
        thresholdRatio: 1,
        headroomTokens: 0,
        retainTokens: 0,
        maxTokens: 64,
        compactionRetries: 0,
        maxOverflowRetries: 0,
      });
      const result = await runTransactionScenario(ctx, scenario, "transaction-fixture");
      expect(result.verified).toBe(true);
      await ctx.fiber.dispose();
      const fresh = new Context();
      try {
        await fresh.plugin(Persistence, { root, compression: "none" });
        const reader = await fresh.sessionPersistence.open(
          SessionId("transaction-fixture"),
          "read",
        );
        try {
          const stored = (await reader.read()).events;
          verifyReplay(stored, result);
        } finally {
          await reader.close();
        }
      } finally {
        await fresh.fiber.dispose();
      }
    } finally {
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);
