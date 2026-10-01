import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { GenerateOptions, StreamChunk } from "@deepseek-ai/dsh-llm";
import { readStored, verifyForest } from "../src/evidence.ts";
import { fixture, FixtureModel } from "./setup.ts";
import {
  startOwnedWorker,
  stopOwnedWorker,
  waitOwnedWorker,
  type OwnedWorker,
} from "./owned-worker.ts";

const contexts: Context[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup(model = new FixtureModel()) {
  const root = await mkdtemp(join(tmpdir(), "dsh-workflow-recovery-"));
  roots.push(root);
  const value = await fixture(root, model);
  contexts.push(value.ctx);
  const parent = await value.ctx.agents.create({
    sessionId: SessionId("parent"),
    agentOptions: { provider: "fixture", model: "fixture" },
    meta: { cwd: root },
  });
  return { ...value, root, parent };
}

it("observes a real PTC SIGKILL after its external marker and refuses workflow completion", async () => {
  const { ctx, root, parent } = await setup();
  const marker = join(root, "ptc-started.json");
  const completion = join(root, "ptc-completed.txt");
  try {
    const run = ctx.workflowEngine.start({
      parent: parent.agent,
      script: `const proc = globalThis.constructor.constructor('return process')();
proc.getBuiltinModule('node:fs').writeFileSync(args.marker, JSON.stringify({ pid: proc.pid, phase: 'started' }));
proc.kill(proc.pid, 'SIGKILL');
proc.getBuiltinModule('node:fs').writeFileSync(args.completion, 'complete');
return { verified: true };`,
      args: { marker, completion },
      meta: { name: "ptc-crash", description: "Observe process death after a durable marker" },
      signal: AbortSignal.timeout(15_000),
    });
    try {
      const result = await run.result;
      const markerBytes = await readFile(marker);
      const observed = JSON.parse(markerBytes.toString("utf8")) as { pid: number; phase: string };
      expect(observed.pid).not.toBe(process.pid);
      expect(observed.phase).toBe("started");
      expect(markerBytes).toEqual(
        Buffer.from(JSON.stringify({ pid: observed.pid, phase: "started" })),
      );
      await expect(access(completion)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.stopReason).toBe("error");
      expect(result.value).toBeNull();
      expect(result.agentsStarted).toBe(0);
      expect(result.error).toMatch(/worker-exit|signal|process/i);
      expect(() => process.kill(observed.pid, 0)).toThrow();
    } finally {
      await run.dispose();
    }
  } finally {
    await parent.dispose();
  }
}, 20_000);

it("reopens a parent-child-grandchild catalog in a new Context and rejects broken edges", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-child-forest-"));
  roots.push(root);
  const model = new GatedModel();
  const first = await fixture(root, model);
  contexts.push(first.ctx);
  const parentId = SessionId("forest-parent");
  const childId = SessionId("forest-child");
  const grandchildId = SessionId("forest-grandchild");
  const parent = await first.ctx.agents.create({
    sessionId: parentId,
    agentOptions: { provider: "fixture", model: "fixture" },
    meta: { cwd: root },
  });
  const offParent = first.ctx.on("agent/pre-step", async (scope, next) =>
    scope.agent === parent.agent ? { kind: "reject" } : next(),
  );
  try {
    await first.ctx.subagents.startContinuable({
      provider: "spawn",
      label: "forest child",
      childId,
      signal: AbortSignal.timeout(15_000),
      request: { parent: parent.agent, prompt: [{ type: "text", text: "Remember CHILD_CODE" }] },
    });
    const child = first.ctx.agents.get(childId);
    expect(child).toBeDefined();
    await first.ctx.subagents.startContinuable({
      provider: "spawn",
      label: "forest grandchild",
      childId: grandchildId,
      signal: AbortSignal.timeout(15_000),
      request: { parent: child!, prompt: [{ type: "text", text: "Remember GRANDCHILD_CODE" }] },
    });
  } finally {
    model.release();
    await first.ctx.subagents.drainContinuableDescendants([parent.agent]);
    offParent();
    await parent.dispose();
  }
  await first.ctx.fiber.dispose();
  const sessions = join(root, "sessions");
  const before = {
    root: await readStored(sessions, parentId),
    child: await readStored(sessions, childId),
    grandchild: await readStored(sessions, grandchildId),
  };
  const reopened = await fixture(root);
  contexts.push(reopened.ctx);
  const rows = await reopened.ctx.subagents.listDescendants(parentId);
  expect(rows.map((row) => [row.id, row.parentId, row.depth, row.kind])).toEqual([
    [childId, parentId, 1, "child"],
    [grandchildId, childId, 2, "child"],
  ]);
  expect(reopened.ctx.agents.get(childId)).toBeUndefined();
  expect(reopened.ctx.agents.get(grandchildId)).toBeUndefined();
  const after = {
    root: await readStored(sessions, parentId),
    child: await readStored(sessions, childId),
    grandchild: await readStored(sessions, grandchildId),
  };
  expect(verifyForest(before, after, { parentId, childId, grandchildId }).edges).toBe(2);
  const missing = {
    ...after,
    child: {
      ...after.child,
      events: after.child.events.filter((event) => event.type !== "subagent/catalog"),
    },
  };
  expect(() => verifyForest(missing, missing, { parentId, childId, grandchildId })).toThrow(
    "child has exactly one direct child",
  );
  const wrongParent = {
    ...after,
    grandchild: {
      ...after.grandchild,
      header: { ...after.grandchild.header, parentSession: SessionId("stranger") },
    },
  };
  expect(() => verifyForest(wrongParent, wrongParent, { parentId, childId, grandchildId })).toThrow(
    "grandchild direct parent",
  );
  const wrongPrefix = {
    ...after,
    grandchild: { ...after.grandchild, events: after.grandchild.events.slice(1) },
  };
  expect(() => verifyForest(before, wrongPrefix, { parentId, childId, grandchildId })).toThrow();
  const extraExecution = {
    ...after,
    grandchild: {
      ...after.grandchild,
      events: [...after.grandchild.events, after.grandchild.events.at(-1)!],
    },
  };
  expect(() => verifyForest(before, extraExecution, { parentId, childId, grandchildId })).toThrow();
  const wrongLabel = {
    ...after,
    child: {
      ...after.child,
      events: after.child.events.map((event) =>
        event.type === "subagent/catalog"
          ? { ...event, data: { ...event.data, label: "wrong label" } }
          : event,
      ),
    },
  };
  expect(() => verifyForest(wrongLabel, wrongLabel, { parentId, childId, grandchildId })).toThrow();
  const extraDescriptor = {
    ...after,
    grandchild: {
      ...after.grandchild,
      events: [
        ...after.grandchild.events,
        {
          ...after.grandchild.events.find((event) => event.type === "subagent/descriptor")!,
          data: { version: 3, mode: "one-shot" as const, provider: "spawn" },
        },
      ],
    },
  };
  expect(() =>
    verifyForest(extraDescriptor, extraDescriptor, { parentId, childId, grandchildId }),
  ).toThrow();
}, 30_000);

it.each(["normal", "crash"] as const)(
  "cold reopens a %s forest in a second process and continues the grandchild",
  async (termination) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-forest-${termination}-`));
    const marker = join(root, "ready.json");
    const worker = join(import.meta.dirname, "../examples/forest-worker.ts");
    const seed = startOwnedWorker(process.execPath, [
      "--import",
      "tsx",
      worker,
      `seed-${termination}`,
      root,
      marker,
    ]);
    let inspect: OwnedWorker | undefined;
    let bodyOutcome: { ok: true } | { ok: false; error: unknown } = { ok: true };
    try {
      const deadline = Date.now() + 15_000;
      let ready:
        | { pid: number; parentId: string; childId: string; grandchildId: string }
        | undefined;
      while (Date.now() < deadline) {
        try {
          ready = JSON.parse(await readFile(marker, "utf8")) as typeof ready;
          break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          if (seed.outcome !== undefined)
            throw new Error(`seed exited before marker: ${seed.stderr}`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(ready).toBeDefined();
      expect(ready!.pid).toBe(seed.child.pid);
      if (termination === "crash") {
        expect(seed.child.kill("SIGKILL")).toBe(true);
        expect((await waitOwnedWorker(seed, 5_000)).signal).toBe("SIGKILL");
      } else {
        expect((await waitOwnedWorker(seed, 15_000)).code, seed.stderr).toBe(0);
      }
      inspect = startOwnedWorker(process.execPath, [
        "--import",
        "tsx",
        worker,
        "inspect",
        root,
        marker,
      ]);
      const inspected = await waitOwnedWorker(inspect, 15_000);
      expect(inspected.code, inspect.stderr).toBe(0);
      const result = JSON.parse(await readFile(join(root, "inspection.json"), "utf8")) as {
        runtimePid: number;
        edges: number;
        completedTurns: number;
        prefixUnchanged: boolean;
      };
      expect(result.runtimePid).not.toBe(ready!.pid);
      expect(result.edges).toBe(2);
      expect(result.completedTurns).toBe(2);
      expect(result.prefixUnchanged).toBe(true);
    } catch (error) {
      bodyOutcome = { ok: false, error };
    }
    const reaped = await Promise.allSettled(
      [seed, inspect]
        .filter((item): item is OwnedWorker => item !== undefined)
        .map((item) => stopOwnedWorker(item, 5_000)),
    );
    if (reaped.some((item) => item.status === "rejected")) {
      throw new Error(`owned worker did not exit; retainedDirectory=${root}`, {
        cause: bodyOutcome.ok ? undefined : bodyOutcome.error,
      });
    }
    await rm(root, { recursive: true, force: true });
    if (!bodyOutcome.ok) throw bodyOutcome.error;
  },
  45_000,
);

class GatedModel extends FixtureModel {
  active = 0;
  peak = 0;
  release!: () => void;
  readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    try {
      await this.gate;
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "CONTROLLED" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "CONTROLLED" } };
      yield { type: "finish", reason: { kind: "stop" } };
    } finally {
      this.active--;
    }
  }
}

it("runs two children concurrently and rejects a third under the published total cap", async () => {
  const model = new GatedModel();
  const { ctx, parent } = await setup(model);
  try {
    const run = ctx.workflowEngine.start({
      parent: parent.agent,
      script: `await parallel([() => agent('one'), () => agent('two')]);
return await agent('third');`,
      meta: {
        name: "bounded-parallel",
        description: "Two concurrent children and a third refusal",
      },
      maxTotalAgents: 2,
      signal: AbortSignal.timeout(15_000),
    });
    try {
      const deadline = Date.now() + 10_000;
      while (model.requests.length < 2 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(model.requests).toHaveLength(2);
      expect(model.peak).toBe(2);
      model.release();
      const result = await run.result;
      expect(result.stopReason).toBe("error");
      expect(result.agentsStarted).toBe(2);
      expect(result.error).toContain("total agent cap (2)");
      expect(model.requests).toHaveLength(2);
    } finally {
      model.release();
      await run.dispose();
    }
  } finally {
    await parent.dispose();
  }
}, 20_000);

class FirstFailureModel extends FixtureModel {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.requests.length === 0) {
      this.requests.push(options);
      throw new Error("controlled first attempt failure");
    }
    yield* super.stream(options);
  }
}

it("uses a bounded second child after a first child failure and retains both outcomes", async () => {
  const model = new FirstFailureModel();
  const { ctx, parent } = await setup(model);
  const started: string[] = [];
  const outcomes: string[] = [];
  const offStart = ctx.on("workflow/agent-start", (_run, child) => started.push(child.childId));
  const offEnd = ctx.on("workflow/agent-end", (_run, child) => outcomes.push(child.outcome));
  try {
    const run = ctx.workflowEngine.start({
      parent: parent.agent,
      script: `const first = await agent('attempt one');
if (first !== null) throw new Error('expected controlled failure');
return await agent('attempt two');`,
      meta: { name: "bounded-retry", description: "One failure then one controlled retry" },
      maxTotalAgents: 2,
      signal: AbortSignal.timeout(15_000),
    });
    try {
      const result = await run.result;
      expect(result.stopReason).toBe("completed");
      expect(result.value).toBe("CONTROLLED");
      expect(result.agentsStarted).toBe(2);
      expect(model.requests).toHaveLength(2);
      expect(outcomes).toEqual(["failed", "completed"]);
      expect(started).toHaveLength(2);
    } finally {
      await run.dispose();
    }
    expect(started.every((id) => ctx.agents.get(SessionId(id)) === undefined)).toBe(true);
  } finally {
    offStart();
    offEnd();
    await parent.dispose();
  }
}, 20_000);
