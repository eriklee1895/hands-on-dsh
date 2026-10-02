/** Two actual SDK runs in one Session, with sanitized persistence and replay verification. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeepSeekHarness, type RunResult } from "@deepseek-ai/dsh-sdk-client";
import { ObservationLedger, type Binding } from "../src/core.ts";
import { readSnapshot, writeSnapshot } from "../src/snapshot.ts";
import { RATES } from "./scenario.ts";

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY)
    throw new Error("Set DEEPSEEK_API_KEY before running this example");
  const root = await mkdtemp(join(tmpdir(), "dsh-observability-live-"));
  let harness: DeepSeekHarness | undefined;
  let verified = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const workspace = join(root, "workspace");
    const osHome = join(root, "os-home");
    await mkdir(workspace);
    await mkdir(osHome);
    const patch = join(root, "no-tools.yml");
    await writeFile(
      patch,
      "- id: persistent-bash\n  disabled: true\n- id: persistent-pwsh\n  disabled: true\n",
    );
    harness = new DeepSeekHarness({
      profile: "sdk-minimal",
      patches: [patch],
      dshHome: join(root, "dsh-home"),
      cwd: workspace,
      processCwd: workspace,
      provider: RATES.provider,
      model: RATES.model,
      maxTokens: 4096,
      initializeTimeoutMs: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: osHome,
        TMPDIR: process.env.TMPDIR,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        ...(process.env.DEEPSEEK_BASE_URL
          ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL }
          : {}),
      },
    });
    const session = harness.session("session-" + randomUUID());
    const sourceId = "source-" + randomUUID();
    const ledger = new ObservationLedger();
    const captured: { binding: Binding; events: RunResult["events"] }[] = [];
    const privateMarkers: string[] = [];
    for (const number of [1, 2]) {
      const marker = "OBS_" + number + "_" + randomUUID();
      privateMarkers.push(marker);
      const result: RunResult = await Promise.race([
        session.run("Reply with exactly " + marker + ". Do not call tools."),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Observation activity deadline expired")),
            180_000,
          );
        }),
      ]);
      clearTimeout(timer);
      timer = undefined;
      assert.equal(result.finalResponse.trim(), marker, "exact private response");
      assert.equal(
        result.events.filter((event) => event.type === "turn/end").at(-1)?.data.reason.kind,
        "completed",
      );
      assert.equal(result.events.filter((event) => event.type === "tool/call").length, 0);
      const binding: Binding = {
        sourceId,
        runId: "run-" + randomUUID(),
        sessionId: result.sessionId,
        provider: RATES.provider,
        model: RATES.model,
      };
      for (const event of result.events) ledger.ingest(binding, event);
      captured.push({ binding, events: result.events });
    }
    const before = captured.map(({ binding }) => ledger.summary(binding.runId, RATES));
    assert.ok(before.every((report) => report.observedAttempts > 0 && report.missingUsage === 0));
    const path = join(root, "checkpoint.json");
    await writeSnapshot(path, ledger);
    const saved = await readFile(path, "utf8");
    for (const marker of privateMarkers)
      assert.ok(!saved.includes(marker), "prompt and reply must not be exported");
    assert.ok(!saved.includes(process.env.DEEPSEEK_API_KEY), "credential must not be exported");
    const reloaded = await readSnapshot(path);
    let duplicates = 0;
    for (const { binding, events } of captured) {
      for (const event of events) {
        assert.equal(reloaded.ingest(binding, event), false);
        duplicates += 1;
      }
    }
    const after = captured.map(({ binding }) => reloaded.summary(binding.runId, RATES));
    assert.deepEqual(after, before);
    console.log(
      JSON.stringify(
        {
          kind: "real-sdk-observation",
          exactReplies: 2,
          tools: 0,
          sameSession: true,
          duplicateEventsIgnored: duplicates,
          checkpointReloaded: true,
          privateMarkersExcluded: true,
          reports: after,
        },
        null,
        2,
      ),
    );
    verified = true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await harness?.close();
      closed = true;
    } finally {
      if (verified && closed) await rm(root, { recursive: true, force: true });
      else console.error(JSON.stringify({ retainedDirectory: root, closed }));
    }
  }
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      failed: true,
      error: error instanceof Error ? error.name : "UnknownError",
      automaticRetry: false,
    }),
  );
  process.exitCode = 1;
});
