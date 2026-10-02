import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Llm from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import { verifyReplay } from "../src/replay-evidence.ts";
import Projections from "@deepseek-ai/dsh-session-projection";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Agents from "@deepseek-ai/dsh-agent";
import Loop from "@deepseek-ai/dsh-agent-loop";
import Meter from "@deepseek-ai/dsh-token-meter";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { runScenario, SCENARIOS } from "../src/fault-scenarios.ts";

it.each(SCENARIOS)(
  "verifies %s through the published loop and compaction engine",
  async (scenario) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-recovery-test-"));
    const ctx = new Context();
    try {
      for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents])
        await ctx.plugin(plugin);
      await ctx.plugin(Persistence, { root, compression: "none" });
      await ctx.plugin(Loop, { agents: [] });
      await ctx.plugin(Meter);
      await ctx.plugin(BasicCompactionEngine, {
        auto: true,
        thresholdRatio: 1,
        headroomTokens: 0,
        retainTokens: 0,
        maxTokens: 64,
        compactionRetries: 0,
        maxOverflowRetries: scenario === "disabled" ? 0 : 1,
      });
      const result = await runScenario(ctx, scenario, "recovery-fixture");
      expect(result.verified).toBe(true);
      const reader = await ctx.sessionPersistence.open(SessionId("recovery-fixture"), "read");
      try {
        const persisted = (await reader.read()).events;
        expect(() => verifyReplay(persisted, result)).not.toThrow();
        if (scenario === "recover-thrown") {
          const changed = structuredClone([...persisted]);
          const checkpoint = changed.find(
            (e) =>
              e.type === "user/message" &&
              typeof e.surfaceOp === "object" &&
              e.surfaceOp.op === "replace",
          );
          expect(checkpoint).toBeDefined();
          if (checkpoint?.type === "user/message")
            checkpoint.data = {
              ...checkpoint.data,
              content: [{ type: "text", text: "TAMPERED CHECKPOINT" }],
            };
          expect(() => verifyReplay(changed, result)).toThrow();
        }
      } finally {
        await reader.close();
      }
    } finally {
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
  15000,
);
