/** Launch two independent supported profiles and verify durable child continuation. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { readStored, verifyCold, verifyBash } from "../src/evidence.ts";

interface Report {
  ok: boolean;
  runtimePid: number;
  phase: string;
  childId: string;
  released: boolean;
  workflowChildIds?: string[];
  discoveredWithoutActivation?: boolean;
}
async function waitReport(path: string): Promise<Report> {
  const deadline = Date.now() + 270_000;
  while (Date.now() < deadline) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await setTimeout(100);
      continue;
    }
    const value: unknown = JSON.parse(raw);
    assert.ok(
      typeof value === "object" && value !== null && "ok" in value && value.ok === true,
      "profile experiment failed; inspect retained report",
    );
    assert.ok("runtimePid" in value && typeof value.runtimePid === "number");
    assert.ok("childId" in value && typeof value.childId === "string");
    assert.ok("released" in value && value.released === true);
    assert.ok("phase" in value && (value.phase === "seed" || value.phase === "resume"));
    return value as Report;
  }
  throw new Error("profile experiment deadline");
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
async function main() {
  assert.ok(process.env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY");
  const root = await mkdtemp(join(tmpdir(), "dsh-workflow-child-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const dshHome = join(root, "dsh-home");
  let owner: DeepSeekHarness | undefined;
  let verified = false;
  let closed = true;
  try {
    await mkdir(workspace);
    await mkdir(home);
    const parentId = "parent-" + randomUUID();
    const childId = "child-" + randomUUID();
    const workflowCode = "FLOW_" + randomUUID().replaceAll("-", "");
    const memoryCode = "MEMORY_" + randomUUID().replaceAll("-", "");
    const reports: Report[] = [];
    async function phase(name: "seed" | "resume") {
      const reportPath = join(root, name + ".json");
      const patch = join(root, name + ".yml");
      const config = {
        phase: name,
        parentId,
        childId,
        workspace,
        report: reportPath,
        ...(name === "seed" ? { workflowCode, memoryCode } : {}),
      };
      if (name === "resume") assert.ok(!JSON.stringify(config).includes(memoryCode));
      const entries = [
        ["lesson-fs", "fs-local", {}],
        ["lesson-query", "session-query-sqlite", { path: ":memory:", openAt: "never" }],
        ["lesson-subagents", "subagent", {}],
        ["lesson-spawn", "subagent-spawn-in-process", {}],
        ["lesson-ptc", "ptc-runtime-node", {}],
        ["lesson-workflow", "workflow-ptc", { maxConcurrentAgents: 2, maxTotalAgents: 2 }],
      ] as const;
      const rows: { id: string; name: string; config: object }[] = entries.map(
        ([id, pkg, settings]) => ({
          id,
          name: fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-" + pkg)),
          config: settings,
        }),
      );
      rows.push({
        id: "lesson",
        name: fileURLToPath(new URL("../dist/lesson-plugin.js", import.meta.url)),
        config,
      });
      // JSON is valid YAML and keeps generated values literal.
      await writeFile(
        patch,
        JSON.stringify(
          [
            { id: "sandbox-policy", config: { mode: "workspace-write", workspaceRoot: workspace } },
            { insert: rows },
          ],
          null,
          2,
        ),
      );
      owner = new DeepSeekHarness({
        profile: "sdk-minimal",
        patches: [patch],
        cwd: workspace,
        processCwd: workspace,
        dshHome,
        initializeTimeoutMs: 120000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: process.env.TMPDIR,
          DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
          ...(process.env.DEEPSEEK_BASE_URL
            ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL }
            : {}),
        },
      });
      closed = false;
      await owner.start();
      const report = await waitReport(reportPath);
      await owner.close();
      closed = true;
      assert.equal(report.childId, childId);
      assert.equal(report.phase, name);
      reports.push(report);
      await rm(patch);
      console.log(
        JSON.stringify({
          phase: name,
          runtimePid: report.runtimePid,
          closed,
          released: report.released,
        }),
      );
      return report;
    }
    const first = await phase("seed");
    assert.ok(
      Array.isArray(first.workflowChildIds) &&
        first.workflowChildIds.length === 2 &&
        first.workflowChildIds.every((id) => typeof id === "string"),
    );
    const sessions = join(dshHome, "sessions");
    const before = await readStored(sessions, childId);
    assert.equal(before.events.filter((e) => e.type === "tool/call").length, 0);
    assert.equal(
      before.events.filter((e) => e.type === "turn/end").at(-1)?.data.reason.kind,
      "completed",
    );
    const initialAnswer = before.events.filter((e) => e.type === "assistant/message").at(-1);
    assert.ok(initialAnswer?.type === "assistant/message");
    assert.equal(
      initialAnswer.data.message.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim(),
      "READY",
    );
    assert.equal(await readFile(join(workspace, "workflow-proof.txt"), "utf8"), workflowCode);
    const writer = await readStored(sessions, first.workflowChildIds[0]!);
    const reader = await readStored(sessions, first.workflowChildIds[1]!);
    verifyBash(writer.events, `printf '%s' '${workflowCode}' > workflow-proof.txt`);
    verifyBash(reader.events, "cat workflow-proof.txt");
    const second = await phase("resume");
    assert.notEqual(first.runtimePid, second.runtimePid, "different runtime process");
    assert.equal(second.discoveredWithoutActivation, true);
    const after = await readStored(sessions, childId);
    const parent = await readStored(sessions, parentId);
    const evidence = verifyCold(before, after, parent, parentId, childId);
    const delta = after.events.slice(before.events.length);
    const messages = delta.filter((e) => e.type === "user/message");
    assert.ok(
      !JSON.stringify(messages).includes(memoryCode),
      "resume input must not supply the code",
    );
    verifyBash(delta, `printf '%s' '${memoryCode}' > cold-proof.txt`);
    assert.equal(await readFile(join(workspace, "cold-proof.txt"), "utf8"), memoryCode);
    console.log(
      JSON.stringify(
        {
          sdk: "0.1.7-rc.2",
          ...evidence,
          parentId,
          runtimePids: reports.map((r) => r.runtimePid),
          workflowChildren: first.workflowChildIds,
          workflowArtifactBytes: Buffer.byteLength(workflowCode),
          workflowArtifactSha256: digest(workflowCode),
          coldArtifactBytes: Buffer.byteLength(memoryCode),
          coldArtifactSha256: digest(memoryCode),
          newPromptContainsCode: false,
          reopenedViaPublishedBackend: true,
        },
        null,
        2,
      ),
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
