/** Reopen official Session logs after Host exit and check the external effects. */
import assert from "node:assert/strict";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readStored } from "../src/evidence.ts";
import {
  verifyAdmission,
  verifyCrashRepair,
  verifyPendingApprovalCancel,
  verifySerialDuplicate,
} from "../src/recovery-evidence.ts";

const duplicateCommand = "printf '%s' 'DUP' >> duplicate-count.txt";
const duplicatePrompt =
  "Call bash exactly once with command: printf '%s' 'DUP' >> duplicate-count.txt . Do not include the final period, use no other tools, do not retry, then reply exactly DUPLICATE_OK.";
const approvalCommand = "printf '%s' 'LATE' >> approval-late.txt";
const crashCommand =
  "printf '%s' 'STARTED' > crash-started.txt; sleep 20; printf '%s' 'CRASH' >> crash-count.txt";

interface RecoveryIds {
  readonly approval: string;
  readonly serialDuplicate: string;
  readonly admission: string;
  readonly crash: string;
  readonly abortedBeforeAdmission: string;
  readonly abortedAfterAdmission: string;
  readonly concurrentDuplicate: string;
}

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
  assert.ok(process.argv[2], "Use: verify-recovery.ts LAB_ROOT");
  const root = await realpath(process.argv[2]);
  const ids: RecoveryIds = JSON.parse(await readFile(join(root, "recovery-ids.json"), "utf8"));
  assert.equal(new Set(Object.values(ids)).size, 7);
  const storage = join(root, "dsh-home/sessions");
  const sessions = await Promise.all(
    [ids.approval, ids.serialDuplicate, ids.admission, ids.crash].map((id) =>
      readStored(storage, id),
    ),
  );
  for (let i = 0; i < sessions.length; i++) {
    assert.equal(
      sessions[i]!.header.id,
      [ids.approval, ids.serialDuplicate, ids.admission, ids.crash][i],
    );
    assert.equal(sessions[i]!.header.version, 4);
    assert.equal(sessions[i]!.header.cwd, join(root, "workspace"));
  }
  const [approval, serialDuplicate, admission, crash] = sessions;
  assert.ok(approval && serialDuplicate && admission && crash);
  const control = verifyPendingApprovalCancel(approval.events, approvalCommand);
  const serial = verifySerialDuplicate(serialDuplicate.events, duplicatePrompt, duplicateCommand);
  const transport = verifyAdmission(
    admission.events,
    {
      beforeAbort: ids.abortedBeforeAdmission,
      afterAbort: ids.abortedAfterAdmission,
      concurrent: ids.concurrentDuplicate,
    },
    {
      afterAbort: "Reply exactly ADMISSION_PROBE_2. Do not use tools.",
      concurrent: "Reply exactly CONCURRENT_DUP. Do not use tools.",
    },
  );
  const repaired = verifyCrashRepair(crash.events, crashCommand);
  const workspace = join(root, "workspace");
  assert.ok(await absent(join(workspace, "approval-late.txt")));
  assert.equal(await readFile(join(workspace, "duplicate-count.txt"), "utf8"), "DUP");
  assert.equal(await readFile(join(workspace, "crash-started.txt"), "utf8"), "STARTED");
  assert.equal(await readFile(join(workspace, "crash-count.txt"), "utf8"), "CRASH");
  const start = await stat(join(workspace, "crash-started.txt"));
  const effect = await stat(join(workspace, "crash-count.txt"));
  assert.ok(effect.mtimeMs - start.mtimeMs >= 18000);
  const result = {
    dshVersion: "0.1.7-rc.2",
    upstream: "477b4f420553e8a52c2fbccc464d7561b239c443",
    persistedEventCounts: {
      approval: approval.events.length,
      serialDuplicate: serialDuplicate.events.length,
      admission: admission.events.length,
      crash: crash.events.length,
    },
    pendingApproval: { ...control, externalAppendAbsent: true },
    serialDuplicate: { ...serial, externalBytes: 3 },
    admission: transport,
    crash: { ...repaired, externalBytesObserved: 5, delayedEffectAfterStart: true },
    publicBackendReopened: true,
  };
  await writeFile(join(root, "recovery-result.json"), JSON.stringify(result, null, 2), {
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
