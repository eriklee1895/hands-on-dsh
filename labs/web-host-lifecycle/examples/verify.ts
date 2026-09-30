/** Reopen persisted Session evidence after stopping the Web Host. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { readStored, verifyTurns } from "../src/evidence.ts";

async function main() {
  const [directory, sessionId, mode] = process.argv.slice(2);
  assert.ok(
    directory && sessionId && (mode === "checkpoint" || mode === "final"),
    "Use: verify.ts LAB_ROOT SESSION_ID checkpoint|final",
  );
  const root = await realpath(directory);
  const state: unknown = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
  assert.ok(
    typeof state === "object" &&
      state !== null &&
      "kind" in state &&
      state.kind === "web-host-lab" &&
      "root" in state &&
      state.root === root,
  );
  assert.ok(
    "code" in state && typeof state.code === "string" && /^WEB_[a-f0-9]{32}$/.test(state.code),
  );
  const code = state.code;
  const snapshot = await readStored(join(root, "dsh-home", "sessions"), sessionId);
  assert.equal(snapshot.header.id, sessionId);
  assert.equal(snapshot.header.version, 4);
  assert.equal(await readFile(join(root, "workspace", "web-proof.txt"), "utf8"), code);
  const first = `printf '%s' '${code}' > web-proof.txt`;
  let beforeEvents: number | undefined;
  if (mode === "checkpoint") {
    verifyTurns(snapshot.events, [first]);
    await writeFile(join(root, "checkpoint.json"), JSON.stringify(snapshot), {
      mode: 0o600,
      flag: "wx",
    });
  } else {
    const before = JSON.parse(await readFile(join(root, "checkpoint.json"), "utf8")) as Awaited<
      ReturnType<typeof readStored>
    >;
    assert.deepEqual(snapshot.header, before.header);
    assert.ok(snapshot.events.length > before.events.length);
    assert.deepEqual(
      snapshot.events.slice(0, before.events.length),
      before.events,
      "historical prefix unchanged",
    );
    assert.ok(
      !JSON.stringify(
        snapshot.events.slice(before.events.length).filter((e) => e.type === "user/message"),
      ).includes(code),
      "new prompt must not contain the remembered code",
    );
    verifyTurns(snapshot.events, [first, `printf '%s' '${code}' > resumed-proof.txt`]);
    assert.equal(await readFile(join(root, "workspace", "resumed-proof.txt"), "utf8"), code);
    beforeEvents = before.events.length;
  }
  const result = {
    mode,
    sessionId,
    version: 4,
    completedTurns: mode === "checkpoint" ? 1 : 2,
    beforeEvents,
    events: snapshot.events.length,
    artifactBytes: Buffer.byteLength(code),
    artifactSha256: createHash("sha256").update(code).digest("hex"),
    publicBackendReopened: true,
  };
  await writeFile(join(root, mode + "-result.json"), JSON.stringify(result), { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ failed: true, error: error instanceof Error ? error.name : "UnknownError" }),
  );
  process.exitCode = 1;
});
