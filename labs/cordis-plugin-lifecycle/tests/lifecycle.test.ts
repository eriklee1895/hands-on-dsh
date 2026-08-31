import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { afterEach, describe, expect, test } from "vitest";
import {
  ProofJournalService,
  createProofConsumer,
  createProofPolicy,
  createProofResource,
} from "../src/proof-journal.ts";
import type { ProofResourceOps } from "../src/proof-journal.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const PENDING = 0;
const ACTIVE = 2;

async function waitForState(fiber: { state: number }, expected: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (fiber.state !== expected) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for state ${expected}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("proof journal lifecycle", () => {
  test("tracks PENDING, provider loss, cleanup, and one clean reactivation", async () => {
    const ctx = new Context();
    const observations: string[] = [];
    const consumer = ctx.plugin(createProofConsumer(observations));
    expect(consumer.state).toBe(PENDING);
    const provider1 = ctx.plugin(ProofJournalService);
    await waitForState(consumer, ACTIVE);
    ctx.proofJournal.record("first");
    await provider1.dispose();
    await waitForState(consumer, PENDING);
    const provider2 = ctx.plugin(ProofJournalService);
    await waitForState(consumer, ACTIVE);
    ctx.proofJournal.record("second");
    expect(observations).toEqual([
      "active:1",
      "recorded:first",
      "cleanup:1",
      "active:2",
      "recorded:second",
    ]);
    await provider2.dispose();
    await ctx.fiber.dispose();
  });

  test("observer delegates waterfall while a distinct policy vetoes", async () => {
    const ctx = new Context();
    const provider = ctx.plugin(ProofJournalService);
    await provider;
    const trace: string[] = [];
    const policy = ctx.plugin(createProofPolicy(trace));
    await policy;
    const allowed = await ctx.waterfall("proof/authorize", "allow", async () => "default-allow");
    const denied = await ctx.waterfall("proof/authorize", "deny", async () => "must-not-run");
    expect({ allowed, denied, trace }).toEqual({
      allowed: "default-allow",
      denied: "vetoed",
      trace: ["observe:allow", "default:allow", "observe:deny", "veto:deny"],
    });
    await ctx.fiber.dispose();
  });

  test("awaits one resource disposer and preserves its external proof", async () => {
    const root = await mkdtemp(join(tmpdir(), "proof-resource-"));
    roots.push(root);
    const resourcePath = join(root, "resource.log");
    const proofPath = join(root, "proof.txt");
    const ctx = new Context();
    const fiber = ctx.plugin(createProofResource({ resourcePath, proofPath }));
    await fiber;
    await fiber.dispose();
    await fiber.dispose();
    expect(await readFile(resourcePath, "utf8")).toBe("opened\nclosed\n");
    expect(await readFile(proofPath, "utf8")).toBe("preserve me\n");
    await ctx.fiber.dispose();
  });

  test.each(["resource-write", "open", "append", "watch", "timer"] as const)(
    "rolls back every acquired resource when %s fails",
    async (failure) => {
      const calls: string[] = [];
      let writes = 0;
      const ops: ProofResourceOps = {
        async write(path) {
          writes += 1;
          calls.push(`write:${path}`);
          if (failure === "resource-write" && writes === 2) throw new Error(failure);
        },
        async remove(path) {
          calls.push(`remove:${path}`);
        },
        async open(path) {
          calls.push(`open:${path}`);
          if (failure === "open") throw new Error(failure);
          return {
            async appendFile() {
              calls.push("append");
              if (failure === "append") throw new Error(failure);
            },
            async close() {
              calls.push("handle-close-start");
              await new Promise((resolve) => setImmediate(resolve));
              calls.push("handle-close-end");
            },
          };
        },
        watch(path) {
          calls.push(`watch:${path}`);
          if (failure === "watch") throw new Error(failure);
          return { close: () => calls.push("watch-close") };
        },
        startTimer() {
          calls.push("timer-start");
          if (failure === "timer") throw new Error(failure);
          return "timer";
        },
        stopTimer() {
          calls.push("timer-stop");
        },
      };
      const ctx = new Context();
      await expect(
        ctx.plugin(
          createProofResource(
            {
              proofPath: "/proof",
              resourcePath: "/resource",
            },
            ops,
          ),
        ),
      ).rejects.toThrow(failure);
      expect(calls).toContain("remove:/proof");
      if (failure !== "resource-write") expect(calls).toContain("remove:/resource");
      if (["append", "watch", "timer"].includes(failure))
        expect(calls).toContain("handle-close-end");
      if (failure === "timer") expect(calls).toContain("watch-close");
      if (failure === "timer") {
        expect(calls.slice(-5)).toEqual([
          "watch-close",
          "handle-close-start",
          "handle-close-end",
          "remove:/resource",
          "remove:/proof",
        ]);
      }
      await ctx.fiber.dispose();
    },
  );
});
