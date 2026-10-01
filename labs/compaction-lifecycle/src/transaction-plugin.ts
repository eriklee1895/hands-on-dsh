/** Profile entry for keyless fault injection over the released runtime. */
import assert from "node:assert/strict";
import { writeFile, rename } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import {
  TRANSACTION_SCENARIOS,
  runTransactionScenario,
  type TransactionScenario,
} from "./transaction-scenarios.ts";
export const name = "lesson-compaction-transactions";
export const inject = [
  "agents",
  "agentLoop",
  "llm",
  "compaction",
  "sessions",
  "sessionPersistence",
];
interface Config {
  scenario: TransactionScenario;
  sessionId: string;
  report: string;
}
export function apply(ctx: Context, config: Config) {
  assert.ok(TRANSACTION_SCENARIOS.includes(config.scenario));
  assert.equal(typeof config.sessionId, "string");
  assert.equal(typeof config.report, "string");
  ctx.effect(() => {
    const task = runTransactionScenario(ctx, config.scenario, config.sessionId)
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
