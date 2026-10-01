/** Controlled released-runtime worker for normal-close and externally killed forest recovery. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { readStored, verifyForest } from "../src/evidence.ts";
import { fixture, FixtureModel } from "../tests/setup.ts";

class GatedModel extends FixtureModel {
  release!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    await this.gate;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "CONTROLLED" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "CONTROLLED" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const [mode, root, marker] = process.argv.slice(2);
assert.ok(mode === "seed-normal" || mode === "seed-crash" || mode === "inspect");
assert.ok(root && marker);
const ids = {
  parentId: SessionId("forest-parent"),
  childId: SessionId("forest-child"),
  grandchildId: SessionId("forest-grandchild"),
};
const signal = () => AbortSignal.timeout(15_000);
const agentOptions = { provider: "fixture", model: "fixture" };
async function waitReleased(ctx: Awaited<ReturnType<typeof fixture>>["ctx"]) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (ctx.agents.get(ids.childId) === undefined && ctx.agents.get(ids.grandchildId) === undefined)
      return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("forest children did not settle before cleanup");
}

async function seed() {
  const model = new GatedModel();
  const { ctx } = await fixture(root!, model);
  const parent = await ctx.agents.create({
    sessionId: ids.parentId,
    agentOptions,
    meta: { cwd: root },
  });
  const offParent = ctx.on("agent/pre-step", async (scope, next) =>
    scope.agent === parent.agent ? { kind: "reject" } : next(),
  );
  try {
    await ctx.subagents.startContinuable({
      provider: "spawn",
      label: "forest child",
      childId: ids.childId,
      signal: signal(),
      request: { parent: parent.agent, prompt: [{ type: "text", text: "Remember CHILD_CODE" }] },
    });
    const child = ctx.agents.get(ids.childId);
    assert.ok(child);
    await ctx.subagents.startContinuable({
      provider: "spawn",
      label: "forest grandchild",
      childId: ids.grandchildId,
      signal: signal(),
      request: { parent: child, prompt: [{ type: "text", text: "Remember GRANDCHILD_CODE" }] },
    });
    model.release();
    await waitReleased(ctx);
    await ctx.subagents.drainContinuableDescendants([parent.agent]);
    await ctx.sessionPersistence.flush();
    if (mode === "seed-normal") {
      offParent();
      await parent.dispose();
      await ctx.fiber.dispose();
    }
    await writeFile(marker!, JSON.stringify({ pid: process.pid, ...ids }));
    if (mode === "seed-crash") await new Promise<void>((resolve) => setTimeout(resolve, 3_600_000));
  } finally {
    model.release();
  }
}

async function inspect() {
  const ready = JSON.parse(await readFile(marker!, "utf8")) as { pid: number };
  const sessions = join(root!, "sessions");
  const before = {
    root: await readStored(sessions, ids.parentId),
    child: await readStored(sessions, ids.childId),
    grandchild: await readStored(sessions, ids.grandchildId),
  };
  const model = new GatedModel();
  const { ctx } = await fixture(root!, model);
  const rows = await ctx.subagents.listDescendants(ids.parentId);
  assert.deepEqual(
    rows.map((row) => [row.id, row.parentId, row.depth, row.kind]),
    [
      [ids.childId, ids.parentId, 1, "child"],
      [ids.grandchildId, ids.childId, 2, "child"],
    ],
  );
  assert.equal(ctx.agents.get(ids.childId), undefined);
  assert.equal(ctx.agents.get(ids.grandchildId), undefined);
  const cold = {
    root: await readStored(sessions, ids.parentId),
    child: await readStored(sessions, ids.childId),
    grandchild: await readStored(sessions, ids.grandchildId),
  };
  verifyForest(before, cold, ids);
  const parent = await ctx.agents.resume({ resumeSessionId: ids.parentId, agentOptions });
  const offParent = ctx.on("agent/pre-step", async (scope, next) =>
    scope.agent === parent.agent ? { kind: "reject" } : next(),
  );
  try {
    await ctx.subagents.sendMessage(
      parent.agent,
      ids.childId,
      [{ type: "text", text: "Recall the child code without files" }],
      { signal: signal() },
    );
    const child = ctx.agents.get(ids.childId);
    assert.ok(child, "cold child activation is resident for direct grandchild delivery");
    await ctx.subagents.sendMessage(
      child,
      ids.grandchildId,
      [{ type: "text", text: "Recall the grandchild code without files" }],
      { signal: signal() },
    );
    model.release();
    await waitReleased(ctx);
    await ctx.subagents.drainContinuableDescendants([parent.agent]);
    await ctx.sessionPersistence.flush();
  } finally {
    model.release();
    offParent();
    await parent.dispose();
    await ctx.fiber.dispose();
  }
  const after = {
    child: await readStored(sessions, ids.childId),
    grandchild: await readStored(sessions, ids.grandchildId),
  };
  for (const name of ["child", "grandchild"] as const) {
    assert.deepEqual(
      after[name].events.slice(0, before[name].events.length),
      before[name].events,
      `${name} immutable prefix`,
    );
    const reasons = after[name].events
      .filter((event) => event.type === "turn/end")
      .map((event) => event.data.reason.kind);
    assert.ok(reasons.length >= 2, `${name} continued after reopen`);
    assert.ok(
      reasons.every((reason) => reason === "completed"),
      `${name} turn reasons: ${reasons}`,
    );
  }
  const grandchildTurnEnds = after.grandchild.events.filter(
    (event) => event.type === "turn/end",
  ).length;
  assert.equal(grandchildTurnEnds, 2, "one grandchild turn in each process");
  const childDelivery = after.child.events
    .slice(before.child.events.length)
    .filter((event) => event.type === "user/message" && event.data.source.kind === "agent-message");
  assert.equal(childDelivery.length, 1);
  assert.ok(
    childDelivery[0]?.type === "user/message" &&
      childDelivery[0].data.source.kind === "agent-message",
  );
  assert.equal(childDelivery[0].data.source.senderSessionId, ids.parentId);
  const delivery = after.grandchild.events
    .slice(before.grandchild.events.length)
    .filter((event) => event.type === "user/message" && event.data.source.kind === "agent-message");
  assert.equal(delivery.length, 1);
  assert.ok(
    delivery[0]?.type === "user/message" && delivery[0].data.source.kind === "agent-message",
  );
  assert.equal(delivery[0].data.source.senderSessionId, ids.childId);
  await writeFile(
    join(root!, "inspection.json"),
    JSON.stringify({
      runtimePid: process.pid,
      priorPid: ready.pid,
      edges: rows.length,
      completedTurns: grandchildTurnEnds,
      prefixUnchanged: true,
      beforeEvents: [before.child.events.length, before.grandchild.events.length],
      afterEvents: [after.child.events.length, after.grandchild.events.length],
    }),
  );
}

await (mode === "inspect" ? inspect() : seed()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : "UnknownError");
  process.exitCode = 1;
});
