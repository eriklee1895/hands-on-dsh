import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { readStored, verifyCold } from "../src/evidence.ts";
import { fixture } from "./setup.ts";
import { runWorkflow, seedChild, continueChild } from "../src/lifecycle.ts";
const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup(root?: string) {
  if (!root) {
    root = await mkdtemp(join(tmpdir(), "dsh-workflow-test-"));
    roots.push(root);
  }
  const value = await fixture(root);
  contexts.push(value.ctx);
  return { ...value, root };
}
const options = { provider: "fixture", model: "fixture" };
const signal = () => AbortSignal.timeout(15000);
it("runs two real children through the published Node PTC process and releases both", async () => {
  const { ctx, model, root } = await setup();
  const parent = await ctx.agents.create({
    sessionId: SessionId("parent"),
    agentOptions: options,
    meta: { cwd: root },
  });
  try {
    const result = await runWorkflow(
      ctx,
      parent.agent,
      'const a = await agent("first"); const b = await agent(a); return {a,b}',
      {},
      signal(),
    );
    expect(result.value).toEqual({ a: "CONTROLLED", b: "CONTROLLED" });
    expect(result.childIds).toHaveLength(2);
    expect(model.requests).toHaveLength(2);
    expect(result.released).toBe(true);
  } finally {
    await parent.dispose();
  }
}, 20000);
it("resumes the same child in a new Context and sends persisted history to its next model request", async () => {
  const first = await setup();
  const parentId = SessionId("parent");
  const childId = SessionId("child");
  const parent = await first.ctx.agents.create({
    sessionId: parentId,
    agentOptions: options,
    meta: { cwd: first.root },
  });
  await seedChild(first.ctx, parent.agent, childId, "Remember FRESH_NONCE", signal());
  expect(first.model.requests).toHaveLength(1);
  await parent.dispose();
  await first.ctx.fiber.dispose();
  const before = await readStored(first.root + "/sessions", childId);
  const second = await setup(first.root);
  expect(second.ctx.agents.get(childId)).toBeUndefined();
  const resumed = await second.ctx.agents.resume({
    resumeSessionId: parentId,
    agentOptions: options,
  });
  try {
    await continueChild(
      second.ctx,
      resumed.agent,
      childId,
      "Recall without repeating the value in this prompt",
      signal(),
    );
    expect(second.model.requests).toHaveLength(1);
    expect(JSON.stringify(second.model.requests[0]!.messages)).toContain("FRESH_NONCE");
    expect(second.ctx.agents.get(childId)).toBeUndefined();
  } finally {
    await resumed.dispose();
  }
  await second.ctx.fiber.dispose();
  const after = await readStored(first.root + "/sessions", childId);
  const parentLog = await readStored(first.root + "/sessions", parentId);
  expect(verifyCold(before, after, parentLog, parentId, childId).prefixUnchanged).toBe(true);
  const altered = { ...structuredClone(after), events: after.events.slice(1) };
  expect(() => verifyCold(before, altered, parentLog, parentId, childId)).toThrow();
  expect(() => verifyCold(before, after, parentLog, "other-parent", childId)).toThrow();
  expect(() => verifyCold(before, before, parentLog, parentId, childId)).toThrow();
}, 20000);
it("rejects a different live parent before admitting a message to the persisted child", async () => {
  const { ctx, root, model } = await setup();
  const owner = await ctx.agents.create({
    sessionId: SessionId("owner"),
    agentOptions: options,
    meta: { cwd: root },
  });
  const stranger = await ctx.agents.create({
    sessionId: SessionId("stranger"),
    agentOptions: options,
    meta: { cwd: root },
  });
  try {
    await seedChild(ctx, owner.agent, SessionId("owned-child"), "Original task", signal());
    await expect(
      continueChild(ctx, stranger.agent, SessionId("owned-child"), "Unauthorized", signal()),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(model.requests).toHaveLength(1);
    expect(ctx.agents.get(SessionId("owned-child"))).toBeUndefined();
  } finally {
    await stranger.dispose();
    await owner.dispose();
  }
}, 20000);
it("does not accept a script error as a completed workflow", async () => {
  const { ctx, root } = await setup();
  const parent = await ctx.agents.create({
    sessionId: SessionId("parent"),
    agentOptions: options,
    meta: { cwd: root },
  });
  try {
    await expect(
      runWorkflow(ctx, parent.agent, 'throw new Error("controlled")', {}, signal()),
    ).rejects.toThrow("workflow must complete");
  } finally {
    await parent.dispose();
  }
});
it("awaits a provider start that returns after cancellation, including its disposal", async () => {
  const { ctx, root } = await setup();
  const parent = await ctx.agents.create({
    sessionId: SessionId("parent"),
    agentOptions: options,
    meta: { cwd: root },
  });
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  let publish!: () => void;
  const publication = new Promise<void>((resolve) => {
    publish = resolve;
  });
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  let disposalStarted!: () => void;
  const disposing = new Promise<void>((resolve) => {
    disposalStarted = resolve;
  });
  let disposals = 0;
  ctx.subagents.registerProvider({
    name: "late",
    capabilities: {
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    },
    inheritsParentContext: false,
    async start() {
      began();
      await publication;
      return {
        id: SessionId("late-child"),
        localAgent: undefined,
        result: Promise.resolve({ output: [], stopReason: "completed" as const }),
        async dispose() {
          disposals++;
          disposalStarted();
          await cleanup;
        },
      };
    },
  });
  const run = ctx.workflowEngine.start({
    parent: parent.agent,
    script: 'return await agent("late")',
    subagentProvider: "late",
    meta: { name: "late-start", description: "Control cancellation at publication" },
    signal: signal(),
  });
  try {
    await started;
    run.cancel();
    let disposed = false;
    const closed = run.dispose().then(() => {
      disposed = true;
    });
    publish();
    await disposing;
    expect(disposed).toBe(false);
    finishCleanup();
    await closed;
    expect((await run.result).stopReason).toBe("cancelled");
    expect(disposals).toBe(1);
    await run.dispose();
    expect(disposals).toBe(1);
  } finally {
    publish();
    finishCleanup();
    await run.dispose();
    await parent.dispose();
  }
}, 20000);
it("rejects tool evidence without a successful matching bash result", async () => {
  const { verifyBash } = await import("../src/evidence.ts");
  expect(() => verifyBash([], "cat workflow-proof.txt")).toThrow();
});
