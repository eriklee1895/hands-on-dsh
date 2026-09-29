/** Run four independent model requests through two published SDK processes. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { RuntimePool, PoolCapacityError } from "../src/pool.ts";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("Set DEEPSEEK_API_KEY for the model example");
const root = await mkdtemp(join(tmpdir(), "hands-on-dsh-pool-"));
const patch = join(root, "no-tools.patch.yml");
await writeFile(
  patch,
  "- id: persistent-bash\n  disabled: true\n- id: persistent-pwsh\n  disabled: true\n",
);
for (const slotId of [1, 2]) {
  await mkdir(join(root, String(slotId), "workspace"), { recursive: true });
  await mkdir(join(root, String(slotId), "os-home"));
}
const pool = new RuntimePool(
  (slotId) => {
    const slotRoot = join(root, String(slotId));
    return new DeepSeekHarness({
      profile: "sdk-minimal",
      patches: [patch],
      dshHome: join(slotRoot, "dsh-home"),
      cwd: join(slotRoot, "workspace"),
      processCwd: join(slotRoot, "workspace"),
      model: process.env.DSH_MODEL ?? "deepseek-flash",
      maxTokens: 4096,
      initializeTimeoutMs: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: join(slotRoot, "os-home"),
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        ...(process.env.DEEPSEEK_BASE_URL
          ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL }
          : {}),
      },
    });
  },
  { size: 2, maxQueued: 2, activityTimeoutMs: 180_000, queueTimeoutMs: 180_000 },
);

async function cleanup(): Promise<void> {
  try {
    await pool.close();
  } catch {
    console.error(JSON.stringify({ closed: false, retainedDirectory: root }));
    throw new Error("Pool close failed; temporary directories retained");
  }
  await rm(root, { recursive: true, force: true });
  console.log(
    JSON.stringify({ closed: true, temporaryHomesRemoved: true, snapshot: pool.snapshot() }),
  );
}

try {
  const tokens = ["POOL_A", "POOL_B", "POOL_C", "POOL_D"];
  const work = tokens.map((token) =>
    pool.run("Reply with exactly " + token + ". Do not use tools."),
  );
  const settlement = Promise.allSettled(work);
  const admitted = pool.snapshot();
  console.log(JSON.stringify({ phase: "admitted", snapshot: admitted }));
  assert.equal(admitted.active, 2);
  assert.equal(admitted.queued, 2);
  await assert.rejects(pool.run("POOL_EXCESS"), PoolCapacityError);
  const results = await settlement;
  const sessionIds = new Set<string>();
  for (const [index, outcome] of results.entries()) {
    if (outcome.status === "rejected") {
      // Transport messages may contain provider details; only print the error class.
      console.error(
        JSON.stringify({
          job: tokens[index],
          error: outcome.reason instanceof Error ? outcome.reason.name : "UnknownError",
        }),
      );
      throw new Error("A pool request failed; no automatic replay was attempted");
    }
    const { slotId, generation, result } = outcome.value;
    const ending = result.events.filter((event) => event.type === "turn/end").at(-1);
    assert.equal(ending?.data.reason.kind, "completed", "root turn must complete");
    assert.equal(result.finalResponse.trim(), tokens[index], "response must exactly match its job");
    assert.equal(result.events.filter((event) => event.type === "tool/call").length, 0);
    sessionIds.add(result.sessionId);
    console.log(
      JSON.stringify({
        job: tokens[index],
        slotId,
        generation,
        sessionId: result.sessionId,
        completed: true,
        exactText: true,
        toolCalls: 0,
      }),
    );
  }
  assert.equal(sessionIds.size, 4);
} finally {
  await cleanup();
}
