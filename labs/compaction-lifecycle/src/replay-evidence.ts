import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { foldSurface, type SessionEvent } from "@deepseek-ai/dsh-session";
/** Hash all JSON event fields with stable object-key ordering; array order remains meaningful. */
export function fingerprintLog(events: readonly SessionEvent[]): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(canonical(events)))
    .digest("hex");
}
/** Refuse a changed checkpoint even if event counts and surface node offsets still match. */
export function verifyReplay(
  events: readonly SessionEvent[],
  expected: { eventCount: number; surfaceNodes: readonly number[]; eventFingerprint: string },
) {
  assert.equal(events.length, expected.eventCount);
  assert.deepEqual(foldSurface(events).nodes, expected.surfaceNodes);
  assert.equal(fingerprintLog(events), expected.eventFingerprint);
}
