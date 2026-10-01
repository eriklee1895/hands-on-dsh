/** Reopen one stopped Web Session after a stale approval reply was delivered. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readStored } from "../src/evidence.ts";
import {
  verifyLateWireCorrelation,
  verifyPendingApprovalCancel,
} from "../src/recovery-evidence.ts";

const command = "printf '%s' 'STALE' >> approval-stale.txt";

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function main(): Promise<void> {
  assert.ok(process.argv[2], "Use: verify-late-approval.ts LAB_ROOT SESSION_ID");
  const sessionId = process.argv[3] ?? "";
  assert.ok(sessionId.startsWith("session-"), "Pass the observed Session ID");
  const root = await realpath(process.argv[2]);
  const audit = JSON.parse(
    await readFile(join(root, "late-wire-audit.json"), "utf8"),
  ) as Parameters<typeof verifyLateWireCorrelation>[0];
  const receipt = JSON.parse(
    await readFile(join(root, "late-answer-receipt.json"), "utf8"),
  ) as Parameters<typeof verifyLateWireCorrelation>[1];
  const stored = await readStored(join(root, "dsh-home/sessions"), sessionId);
  assert.equal(stored.header.id, sessionId);
  assert.equal(stored.header.version, 4);
  assert.equal(stored.header.cwd, join(root, "workspace"));
  const cancelled = verifyPendingApprovalCancel(stored.events, command);
  const correlation = verifyLateWireCorrelation(audit, receipt, sessionId, stored.events);
  assert.ok(await absent(join(root, "workspace/approval-stale.txt")));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const ask = stored.events.find((event) => event.type === "approval/asked");
  assert.ok(ask?.data.callId);
  const proof = {
    schema: "web-late-approval-correlation-v1",
    capture: audit.captures[0],
    outgoingPosts: audit.posts,
    browserReceipt: receipt,
    durable: {
      sessionIdHash: digest(sessionId),
      askedCallIdHash: digest(ask.data.callId),
      decision: "cancelled",
      turn: "aborted",
      targetFileAbsent: true,
    },
  };
  await writeFile(join(root, "late-correlation-proof.json"), JSON.stringify(proof, null, 2), {
    mode: 0o600,
  });
  const result = {
    dshVersion: "0.1.7-rc.2",
    eventCount: stored.events.length,
    staleWire: { ...correlation, applied: false },
    ...cancelled,
    externalAppendAbsent: true,
    publicBackendReopened: true,
  };
  await writeFile(join(root, "late-approval-result.json"), JSON.stringify(result, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify(result, null, 2));
}

await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ failed: true, error: error instanceof Error ? error.name : "UnknownError" }),
  );
  process.exitCode = 1;
});
