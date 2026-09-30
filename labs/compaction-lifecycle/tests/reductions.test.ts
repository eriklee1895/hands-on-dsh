import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Llm from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId, foldSurface } from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Agents from "@deepseek-ai/dsh-agent";
import Loop from "@deepseek-ai/dsh-agent-loop";
import Meter from "@deepseek-ai/dsh-token-meter";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import Pruner from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import * as Offload from "@deepseek-ai/dsh-compaction-image-offload";
import { imageOffloadProjection } from "@deepseek-ai/dsh-compaction-image-offload/projection";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { verifyReplay, fingerprintJson } from "../src/replay-evidence.ts";
import {
  REDUCTION_SCENARIOS,
  reductionConfig,
  runReduction,
  reductionMessages,
  type ReductionScenario,
} from "../src/reduction-scenarios.ts";

async function withHarness(
  scenario: ReductionScenario,
  body: (ctx: Context, root: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "dsh-reduction-test-"));
  const ctx = new Context();
  try {
    for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents])
      await ctx.plugin(plugin);
    await ctx.plugin(Persistence, { root: join(root, "sessions"), compression: "none" });
    await ctx.plugin(Loop, { agents: [] });
    await ctx.plugin(Meter);
    await ctx.plugin(Pruner, { thresholdChars: 256, headChars: 24, tailChars: 24 });
    await ctx.plugin(Offload);
    await ctx.plugin(BasicCompactionEngine, reductionConfig(scenario));
    await body(ctx, root);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
it.each(REDUCTION_SCENARIOS)(
  "verifies %s over real published services",
  async (scenario) => {
    await withHarness(scenario, async (ctx, root) => {
      const result = await runReduction(
        ctx,
        scenario,
        "reduction-fixture",
        join(root, "fixture.png"),
      );
      expect(result.verified).toBe(true);
      const reader = await ctx.sessionPersistence.open(SessionId("reduction-fixture"), "read");
      try {
        const events = (await reader.read()).events;
        expect(() => verifyReplay(events, result, [imageOffloadProjection])).not.toThrow();
        expect(fingerprintJson(reductionMessages(events))).toBe(result.projectedFingerprint);
        if (scenario === "image-agent-recover") {
          expect(() => foldSurface(events)).toThrow();
          const duplicate = structuredClone([...events]);
          const invalid = duplicate.find((e) => e.type === "image/offload");
          if (invalid?.type === "image/offload")
            invalid.data = {
              targets: [{ seq: invalid.data.targets[0]!.seq, imageIndexes: [0, 0] }],
            };
          expect(() => reductionMessages(duplicate)).toThrow();
          const swapped = structuredClone([...events]);
          const changed = swapped.find((e) => e.type === "image/offload");
          if (changed?.type === "image/offload")
            changed.data = { targets: [{ seq: changed.data.targets[0]!.seq, imageIndexes: [1] }] };
          expect(foldSurface(swapped, [imageOffloadProjection]).nodes).toEqual(result.surfaceNodes);
          expect(fingerprintJson(reductionMessages(swapped))).not.toBe(result.projectedFingerprint);
          expect(() => verifyReplay(swapped, result, [imageOffloadProjection])).toThrow();
        }
      } finally {
        await reader.close();
      }
    });
  },
  15000,
);
it.each(["metadata", "position"] as const)(
  "rejects a live pruner that corrupts rich-block %s",
  async (corruption) => {
    await withHarness("prune-preserves-offload", async (ctx, root) => {
      const prune = ctx.toolResultPruner.pruneContent.bind(ctx.toolResultPruner);
      ctx.toolResultPruner.pruneContent = (blocks) => {
        const result = prune(blocks);
        if (result === null) return null;
        if (corruption === "metadata")
          return result.map((block) =>
            block.type === "image"
              ? { ...block, attachment: { ...block.attachment, name: "CORRUPTED_NAME.png" } }
              : block,
          );
        return [
          ...result.filter((b) => b.type !== "text"),
          ...result.filter((b) => b.type === "text"),
        ];
      };
      await expect(
        runReduction(ctx, "prune-preserves-offload", "corrupt-pruner", join(root, "fixture.png")),
      ).rejects.toThrow();
    });
  },
);
