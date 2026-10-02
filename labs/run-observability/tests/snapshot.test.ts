import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ObservationLedger } from "../src/core.ts";
import { readSnapshot, writeSnapshot } from "../src/snapshot.ts";

it("reloads only normalized observations and preserves duplicate detection", async () => {
  const root = await mkdtemp(join(tmpdir(), "observations-test-"));
  try {
    const path = join(root, "snapshot.json");
    const ledger = new ObservationLedger();
    const binding = {
      sourceId: "store-demo",
      runId: "run-a",
      sessionId: "session-demo",
      provider: "deepseek-official",
      model: "deepseek-flash",
    };
    const event = {
      seq: 0,
      time: 10,
      type: "user/message",
      data: { content: "PRIVATE_PAYLOAD_SENTINEL" },
    };
    ledger.ingest(binding, event);
    await writeFile(path, "old checkpoint");
    await writeSnapshot(path, ledger);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain("PRIVATE_PAYLOAD_SENTINEL");
    const reloaded = await readSnapshot(path);
    expect(reloaded.exportRecords()).toEqual(ledger.exportRecords());
    expect(reloaded.ingest(binding, event)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("rejects malformed or extra snapshot fields without echoing payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "observations-test-"));
  try {
    const path = join(root, "snapshot.json");
    for (const content of [
      '{"private":"PRIVATE_PAYLOAD_SENTINEL"}',
      '{"schemaVersion":1,"records":[],"extra":true}',
      '{"PRIVATE_PAYLOAD_SENTINEL":',
    ]) {
      await writeFile(path, content);
      await expect(readSnapshot(path)).rejects.toThrow("Invalid observation snapshot");
      try {
        await readSnapshot(path);
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE_PAYLOAD_SENTINEL");
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
