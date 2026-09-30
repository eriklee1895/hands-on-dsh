/** Run controlled fault cases through separate public profiles, then reopen each persisted log. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { verifyReplay } from "../src/replay-evidence.ts";
import { SCENARIOS, type runScenario } from "../src/fault-scenarios.ts";
import { readPersisted } from "../src/verify.ts";
type Report = Awaited<ReturnType<typeof runScenario>> & { ok: true; runtimePid: number };
async function readReport(path: string): Promise<Report> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await setTimeout(50);
      continue;
    }
    const value: unknown = JSON.parse(raw);
    assert.ok(
      typeof value === "object" && value !== null && "ok" in value && value.ok === true,
      "profile scenario failed; report retained",
    );
    assert.ok(
      "verified" in value &&
        value.verified === true &&
        "runtimePid" in value &&
        typeof value.runtimePid === "number",
    );
    return value as Report;
  }
  throw new Error("profile report deadline");
}
async function main() {
  const root = await mkdtemp(join(tmpdir(), "dsh-compaction-faults-"));
  let owner: DeepSeekHarness | undefined;
  let closed = true;
  let verified = false;
  const results: object[] = [];
  try {
    for (const scenario of SCENARIOS) {
      const directory = join(root, scenario);
      const workspace = join(directory, "workspace");
      const home = join(directory, "home");
      const dshHome = join(directory, "dsh-home");
      await mkdir(workspace, { recursive: true });
      await mkdir(home);
      const reportPath = join(directory, "report.json");
      const patch = join(directory, "faults.json");
      const sessionId = "fault-" + scenario;
      const modulePath = (name: string) => fileURLToPath(import.meta.resolve(name));
      await writeFile(
        patch,
        JSON.stringify([
          {
            insert: [
              { id: "lesson-meter", name: modulePath("@deepseek-ai/dsh-token-meter") },
              {
                id: "lesson-compaction",
                name: modulePath("@deepseek-ai/dsh-compaction-basic"),
                config: {
                  auto: true,
                  thresholdRatio: 1,
                  headroomTokens: 0,
                  retainTokens: 0,
                  maxTokens: 64,
                  compactionRetries: 0,
                  maxOverflowRetries: scenario === "disabled" ? 0 : 1,
                },
              },
              {
                id: "lesson-faults",
                name: fileURLToPath(new URL("../dist/fault-plugin.js", import.meta.url)),
                config: { scenario, sessionId, report: reportPath },
              },
            ],
          },
        ]),
      );
      owner = new DeepSeekHarness({
        profile: "sdk-minimal",
        patches: [patch],
        cwd: workspace,
        processCwd: workspace,
        dshHome,
        initializeTimeoutMs: 60000,
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR },
      });
      closed = false;
      await owner.start();
      const report = await readReport(reportPath);
      await owner.close();
      closed = true;
      assert.equal(report.scenario, scenario);
      assert.equal(report.sessionId, sessionId);
      const persisted = await readPersisted(join(dshHome, "sessions"), sessionId);
      assert.equal(persisted.header.version, 4);
      verifyReplay(persisted.events, report);
      assert.deepEqual(
        persisted.events.filter((e) => e.type.startsWith("compaction/")).map((e) => e.type),
        report.markerTypes,
      );
      const result = {
        ...report,
        persistedV4: true,
        fullEventFingerprintEqual: true,
        replaySurfaceEqual: true,
        apiKeyPassed: false,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
    console.log(
      JSON.stringify({ scenarios: results.length, allVerified: true, externalModelRequests: 0 }),
    );
    verified = true;
  } finally {
    let removed = false;
    try {
      if (owner && !closed) {
        await owner.close();
        closed = true;
      }
    } finally {
      try {
        if (verified && closed) {
          await rm(root, { recursive: true, force: true });
          removed = true;
        }
      } finally {
        if (!removed) console.error(JSON.stringify({ retainedDirectory: root, closed }));
      }
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
