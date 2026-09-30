/** A profile-mounted host experiment; the parent does not ask a model to orchestrate it. */
import assert from "node:assert/strict";
import { writeFile, rename } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { runWorkflow, seedChild, continueChild } from "./lifecycle.ts";

export const name = "lesson-workflow-child";
export const inject = [
  "agents",
  "agentLoop",
  "workflowEngine",
  "subagents",
  "sessionPersistence",
  "sessionQuery",
];
interface Config {
  phase: "seed" | "resume";
  parentId: string;
  childId: string;
  workspace: string;
  report: string;
  workflowCode?: string;
  memoryCode?: string;
}

/** Mount one bounded experiment and retain its cleanup obligation until plugin disposal. */
export function apply(ctx: Context, config: Config): void {
  assert.ok(config.phase === "seed" || config.phase === "resume");
  for (const field of [config.parentId, config.childId, config.workspace, config.report])
    assert.equal(typeof field, "string");
  ctx.effect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    const task = execute(ctx, config, controller.signal)
      .then((result) => ({ ok: true, runtimePid: process.pid, ...result }))
      .catch((error: unknown) => ({
        ok: false,
        runtimePid: process.pid,
        error: error instanceof Error ? error.name : "UnknownError",
      }))
      .then(async (report) => {
        await writeFile(config.report + ".tmp", JSON.stringify(report));
        await rename(config.report + ".tmp", config.report);
      })
      .finally(() => clearTimeout(timer));
    // The effect owns the task rejection; disposal still awaits and surfaces a failed report write.
    void task.catch(() => undefined);
    return async () => {
      controller.abort();
      await task;
    };
  });
}

async function execute(ctx: Context, config: Config, signal: AbortSignal) {
  const agentOptions = { provider: "deepseek-official", model: "deepseek-flash", maxTokens: 512 };
  const parentId = SessionId(config.parentId);
  const childId = SessionId(config.childId);
  const parent =
    config.phase === "seed"
      ? await ctx.agents.create({
          sessionId: parentId,
          agentOptions,
          meta: { cwd: config.workspace },
        })
      : await ctx.agents.resume({ resumeSessionId: parentId, agentOptions });
  try {
    if (config.phase === "resume") {
      assert.equal(config.memoryCode, undefined);
      assert.equal(config.workflowCode, undefined);
      const before = await ctx.subagents.listChildren(parentId);
      assert.equal(
        before.filter((entry) => entry.id === childId && entry.mode === "continuable").length,
        1,
      );
      assert.equal(ctx.agents.get(childId), undefined);
      const result = await continueChild(
        ctx,
        parent.agent,
        childId,
        "Write the exact recovery code from our earlier conversation to cold-proof.txt, with no trailing newline. Call bash exactly once using printf '%s' 'RECOVERY_CODE' > cold-proof.txt with the remembered code substituted. Do not read any files, environment variables, or logs. Do not call any other tools. Then reply with exactly DONE.",
        signal,
      );
      return { phase: "resume", ...result, discoveredWithoutActivation: true };
    }
    assert.match(config.workflowCode ?? "", /^FLOW_[a-f0-9]{32}$/);
    assert.match(config.memoryCode ?? "", /^MEMORY_[a-f0-9]{32}$/);
    const script = `phase('Write');
const written = await agent("Call bash exactly once with this exact command: printf '%s' '" + args.code + "' > workflow-proof.txt . Do not include the sentence's final period in the command. No other tools or commands. Then reply exactly WRITTEN.");
if (written === null || written.trim() !== 'WRITTEN') throw new Error('writer failed');
phase('Read');
const read = await agent("Call bash exactly once with the exact command cat workflow-proof.txt . No other tools or commands. Reply with only the exact file content.");
if (read === null || read.trim() !== args.code) throw new Error('reader failed');
return { verified: true };`;
    const workflow = await runWorkflow(
      ctx,
      parent.agent,
      script,
      { code: config.workflowCode },
      signal,
    );
    assert.deepEqual(workflow.value, { verified: true });
    assert.equal(workflow.childIds.length, 2);
    const seeded = await seedChild(
      ctx,
      parent.agent,
      childId,
      `Remember this exact recovery code for a later task: ${config.memoryCode}. Reply exactly READY. Do not call any tools or write the code to a file.`,
      signal,
    );
    return {
      phase: "seed",
      ...seeded,
      workflowChildIds: workflow.childIds,
      workflowReleased: workflow.released,
    };
  } finally {
    await ctx.subagents.drainContinuableDescendants([parent.agent]);
    await parent.dispose();
  }
}
