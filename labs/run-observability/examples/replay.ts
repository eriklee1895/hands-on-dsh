/** Rehydrate a sanitized checkpoint, then replay duplicate and out-of-order source events. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationLedger } from "../src/core.ts";
import { readSnapshot, writeSnapshot } from "../src/snapshot.ts";
import { EVENTS_A, EVENTS_B, RATES, RUN_A, RUN_B, SENTINEL } from "./scenario.ts";

const directory = await mkdtemp(join(tmpdir(), "dsh-observability-replay-"));
try {
  const ledger = new ObservationLedger();
  for (const event of [...EVENTS_A].reverse()) ledger.ingest(RUN_A, event);
  for (const event of EVENTS_B) ledger.ingest(RUN_B, event);
  const before = [ledger.summary(RUN_A.runId, RATES), ledger.summary(RUN_B.runId, RATES)];
  assert.equal(before[0]!.knownUsageEstimateNanoUsd, "43300");
  assert.equal(before[0]!.observedAttempts, 2);
  assert.equal(before[1]!.missingUsage, 1);
  const file = join(directory, "checkpoint.json");
  await writeSnapshot(file, ledger);
  assert.ok(!(await readFile(file, "utf8")).includes(SENTINEL));
  const restored = await readSnapshot(file);
  let duplicates = 0;
  for (const [binding, events] of [
    [RUN_A, EVENTS_A],
    [RUN_B, EVENTS_B],
  ] as const) {
    for (const event of events) {
      if (!restored.ingest(binding, event)) duplicates += 1;
    }
  }
  const after = [restored.summary(RUN_A.runId, RATES), restored.summary(RUN_B.runId, RATES)];
  assert.deepEqual(after, before);
  console.log(
    JSON.stringify(
      {
        kind: "synthetic-example",
        duplicateEventsIgnored: duplicates,
        checkpointReloaded: true,
        payloadExcluded: true,
        reports: after,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
