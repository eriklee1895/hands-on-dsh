/** Check reported operations and independently inspect their actual file effects. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import type { Operation, ProbeInput, WorkerReport } from "./worker.ts";

export function expectedWrites(mode: SandboxMode) {
  return {
    insideWrite: mode !== "read-only",
    outsideWrite: mode === "danger-full-access",
    symlinkWrite: mode === "danger-full-access",
    descendantWrite: mode === "danger-full-access",
    tempWrite: mode !== "read-only",
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Reject incomplete results, incorrect nonce, unexpected permission errors or capabilities. */
export function validateReport(value: unknown, input: ProbeInput, mode: SandboxMode): WorkerReport {
  assert.ok(record(value), "worker result must be an object");
  assert.equal(value.nonce, input.nonce, "worker nonce");
  assert.ok(record(value.operations), "worker operations");
  const expected = {
    ...expectedWrites(mode),
    outsideRead: true,
    loopback: true,
    parentVisible: true,
  };
  assert.deepEqual(Object.keys(value.operations).sort(), Object.keys(expected).sort());
  const operations = value.operations;
  function check(key: keyof typeof expected): Operation {
    const allowed = expected[key];
    const operation: unknown = operations[key];
    assert.ok(record(operation), key + " result");
    const status = allowed ? "allowed" : "denied";
    assert.equal(operation.status, status, key + " policy result");
    if (!allowed)
      assert.ok(
        ["EPERM", "EACCES", "EROFS"].includes(String(operation.code)),
        key + " denial code",
      );
    const canary = key === "outsideRead" || key === "loopback";
    if (canary) assert.equal(operation.value, input.nonce, key + " canary");
    return {
      status,
      ...(!allowed ? { code: String(operation.code) } : {}),
      ...(canary ? { value: input.nonce } : {}),
    };
  }
  return {
    nonce: input.nonce,
    operations: {
      insideWrite: check("insideWrite"),
      outsideRead: check("outsideRead"),
      outsideWrite: check("outsideWrite"),
      symlinkWrite: check("symlinkWrite"),
      descendantWrite: check("descendantWrite"),
      tempWrite: check("tempWrite"),
      loopback: check("loopback"),
      parentVisible: check("parentVisible"),
    },
  };
}
/** Compare each file with its exact expected bytes; denial requires absence, not empty output. */
export async function verifyFiles(input: ProbeInput, mode: SandboxMode): Promise<void> {
  const paths = {
    insideWrite: join(input.workspace, "inside.txt"),
    outsideWrite: join(input.outside, "outside.txt"),
    symlinkWrite: join(input.outside, "symlink.txt"),
    descendantWrite: join(input.outside, "descendant.txt"),
    tempWrite: join(input.temp, "temp.txt"),
  };
  for (const [name, allowed] of Object.entries(expectedWrites(mode))) {
    const path = paths[name as keyof typeof paths];
    if (allowed) assert.equal(await readFile(path, "utf8"), input.nonce, name + " external bytes");
    else await assert.rejects(readFile(path), { code: "ENOENT" }, name + " must leave no file");
  }
  assert.equal(await readFile(join(input.outside, "canary.txt"), "utf8"), input.nonce);
}
