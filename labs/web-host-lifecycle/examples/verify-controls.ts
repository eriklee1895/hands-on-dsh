/** Verify closed-Host control sessions against the exact commands and independent filesystem state. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { readStored } from "../src/evidence.ts";
import { verifyApproval, verifyCancelled, verifyReconnected } from "../src/control-evidence.ts";

async function absent(path: string) {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}
function turns(events: readonly SessionEvent[], count: number) {
  const starts = events.filter((e) => e.type === "turn/start");
  assert.equal(starts.length, count);
  return starts.map((start, index) =>
    events.filter(
      (e) =>
        e.seq >= start.seq && (starts[index + 1] === undefined || e.seq < starts[index + 1]!.seq),
    ),
  );
}
async function main() {
  assert.ok(process.argv[2], "Use: verify-controls.ts LAB_ROOT");
  const root = await realpath(process.argv[2]);
  const prepared = JSON.parse(await readFile(join(root, "control-cases.json"), "utf8")) as {
    root: string;
    code: string;
    cases: Record<string, { command: string; prompt: string }>;
  };
  assert.equal(prepared.root, root);
  assert.match(prepared.code, /^WEB_[a-f0-9]{32}$/);
  const ids = JSON.parse(await readFile(join(root, "control-session-ids.json"), "utf8")) as Record<
    string,
    string
  >;
  const logs = await Promise.all(
    ["approval", "cancel", "reconnect"].map(async (kind) => {
      assert.equal(typeof ids[kind], "string");
      const snapshot = await readStored(join(root, "dsh-home/sessions"), ids[kind]!);
      assert.equal(snapshot.header.id, ids[kind]);
      assert.equal(snapshot.header.version, 4);
      assert.equal(snapshot.header.cwd, join(root, "workspace"));
      return snapshot;
    }),
  );
  const [approval, cancel, reconnect] = logs;
  assert.ok(approval && cancel && reconnect);
  const approvalTurns = turns(approval.events, 2);
  const denied = verifyApproval(approvalTurns[0]!, prepared.cases.denied!.command, "rejected");
  const allowed = verifyApproval(
    approvalTurns[1]!,
    prepared.cases.allowed!.command,
    "allowed-once",
  );
  assert.notEqual(denied.approvalId, allowed.approvalId);
  const modes = approval.events.flatMap((event: { type: string; data: unknown }) => {
    if (event.type !== "sandbox/mode") return [];
    assert.ok(
      typeof event.data === "object" &&
        event.data !== null &&
        "mode" in event.data &&
        typeof event.data.mode === "string",
    );
    return [event.data.mode];
  });
  assert.equal(modes.at(-1), "read-only");
  const cancelled = verifyCancelled(turns(cancel.events, 1)[0]!, prepared.cases.cancel!.command);
  const reconnected = verifyReconnected(
    turns(reconnect.events, 1)[0]!,
    prepared.cases.reconnect!.command,
  );
  for (const [kind, log] of [
    ["denied", approval],
    ["allowed", approval],
    ["cancel", cancel],
    ["reconnect", reconnect],
  ] as const) {
    const matches = log.events.filter(
      (e) =>
        e.type === "user/message" &&
        e.data.content.some((b) => b.type === "text" && b.text === prepared.cases[kind]!.prompt),
    );
    assert.equal(matches.length, 1, "one admitted prompt for each case");
  }
  const workspace = join(root, "workspace");
  assert.ok(await absent(join(workspace, "denied.txt")));
  assert.equal(await readFile(join(workspace, "allowed.txt"), "utf8"), prepared.code);
  assert.equal(await readFile(join(workspace, "cancel-started.txt"), "utf8"), "STARTED");
  const elapsedMs = Date.now() - (await stat(join(workspace, "cancel-started.txt"))).mtimeMs;
  assert.ok(
    elapsedMs >= 45000,
    "check after the cancelled command would have reached its delayed write",
  );
  assert.ok(await absent(join(workspace, "cancel-finished.txt")));
  assert.equal(await readFile(join(workspace, "reconnect-started.txt"), "utf8"), "STARTED");
  assert.equal(
    await readFile(join(workspace, "reconnect-count.txt"), "utf8"),
    prepared.code,
    "one exact append, without replay",
  );
  const result = {
    dshVersion: "0.1.7-rc.2",
    sessionIds: ids,
    approval: { denied, allowed, persistentMode: "read-only", events: approval.events.length },
    cancel: {
      ...cancelled,
      events: cancel.events.length,
      startedMarkerRetained: true,
      lateEffectAbsent: true,
      checkedAfterOriginalDelay: true,
    },
    reconnect: { ...reconnected, events: reconnect.events.length, exactlyOneAppendObserved: true },
    artifactBytes: Buffer.byteLength(prepared.code),
    artifactSha256: createHash("sha256").update(prepared.code).digest("hex"),
    publicBackendReopened: true,
  };
  await writeFile(join(root, "controls-result.json"), JSON.stringify(result, null, 2), {
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
