/** Profile entry for controlled text pruning and durable image selection. */
import assert from "node:assert/strict";
import { writeFile, rename } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import {
  REDUCTION_SCENARIOS,
  runReduction,
  type ReductionScenario,
} from "./reduction-scenarios.ts";
export const name = "lesson-compaction-reductions";
export const inject = [
  "agents",
  "agentLoop",
  "llm",
  "tools",
  "sessions",
  "compaction",
  "toolResultPruner",
  "sessionPersistence",
];
interface Config {
  scenario: ReductionScenario;
  sessionId: string;
  report: string;
  imagePath: string;
}
export function apply(ctx: Context, config: Config) {
  assert.ok(REDUCTION_SCENARIOS.includes(config.scenario));
  for (const field of [config.sessionId, config.report, config.imagePath])
    assert.equal(typeof field, "string");
  assert.ok(
    ctx.sessions.messageProjections.some((projection) => projection.type === "image/offload"),
    "mount image offload before the scenario",
  );
  ctx.effect(() => {
    const task = runReduction(ctx, config.scenario, config.sessionId, config.imagePath)
      .then((result) => ({ ok: true, runtimePid: process.pid, ...result }))
      .catch((error: unknown) => ({
        ok: false,
        runtimePid: process.pid,
        error: error instanceof Error ? error.name : "UnknownError",
      }))
      .then(async (value) => {
        await writeFile(config.report + ".tmp", JSON.stringify(value), { mode: 0o600 });
        await rename(config.report + ".tmp", config.report);
      });
    void task.catch(() => undefined);
    return async () => {
      await task;
    };
  });
}
