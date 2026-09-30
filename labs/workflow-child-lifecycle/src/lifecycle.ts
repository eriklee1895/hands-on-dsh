/** Holder-owned workflow runs and parent-authorized durable child messages. */
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SubagentRunEndInfo } from "@deepseek-ai/dsh-subagent";
import type { WorkflowAgentEndInfo, WorkflowAgentInfo } from "@deepseek-ai/dsh-workflow";

/** Run one script, require completed children, and await disposal before returning evidence. */
export async function runWorkflow(
  ctx: Context,
  parent: Agent,
  script: string,
  args: object,
  signal: AbortSignal,
) {
  const started: WorkflowAgentInfo[] = [];
  const ended: WorkflowAgentEndInfo[] = [];
  const offStart = ctx.on("workflow/agent-start", (_info, child) => {
    started.push(child);
  });
  const offEnd = ctx.on("workflow/agent-end", (_info, child) => {
    ended.push(child);
  });
  try {
    const run = ctx.workflowEngine.start({
      script,
      args,
      parent,
      signal,
      meta: { name: "lesson-workflow", description: "Sequential child artifact verification" },
    });
    let result;
    try {
      result = await run.result;
    } finally {
      await run.dispose();
    }
    assert.equal(result.stopReason, "completed", "workflow must complete");
    assert.equal(result.agentsStarted, started.length);
    assert.equal(ended.length, started.length);
    for (const child of started) {
      assert.equal(
        ended.filter(
          (end) =>
            end.seq === child.seq && end.childId === child.childId && end.outcome === "completed",
        ).length,
        1,
      );
      assert.equal(ctx.agents.get(child.childId), undefined, "child handle released");
    }
    return { value: result.value, childIds: started.map((child) => child.childId), released: true };
  } finally {
    offStart();
    offEnd();
  }
}

async function withChild(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  signal: AbortSignal,
  admit: () => Promise<unknown>,
) {
  const outcomes: SubagentRunEndInfo[] = [];
  const offEnd = ctx.on("subagent/end", (info) => {
    if (info.id === childId) outcomes.push(info);
  });
  // This host-driven lab gives settlement notices no model work on the parent.
  const offParent = ctx.on("agent/pre-step", async (scope, next) =>
    scope.agent === parent ? { kind: "reject" } : next(),
  );
  try {
    await admit();
    while (ctx.agents.get(childId) !== undefined) await setTimeout(10, undefined, { signal });
    await parent.whenIdle();
    assert.equal(outcomes.length, 1, "one residency outcome");
    assert.equal(outcomes[0]!.stopReason, "completed", "child must complete");
    return { childId, released: true, stopReason: outcomes[0]!.stopReason };
  } finally {
    offEnd();
    offParent();
  }
}

/** Create a continuable child and wait past admission until its first residency is released. */
export async function seedChild(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  prompt: string,
  signal: AbortSignal,
) {
  return withChild(ctx, parent, childId, signal, () =>
    ctx.subagents.startContinuable({
      provider: "spawn",
      label: "Remember a recovery code",
      childId,
      signal,
      request: { parent, prompt: [{ type: "text", text: prompt }] },
    }),
  );
}

/** Cold resume through the exact live direct parent, without creating a replacement child. */
export async function continueChild(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  prompt: string,
  signal: AbortSignal,
) {
  assert.equal(ctx.agents.get(childId), undefined, "child must be absent before cold delivery");
  return withChild(ctx, parent, childId, signal, () =>
    ctx.subagents.sendMessage(parent, childId, [{ type: "text", text: prompt }], { signal }),
  );
}
