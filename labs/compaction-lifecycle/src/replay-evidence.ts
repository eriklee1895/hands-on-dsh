import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { foldSurface, type SessionEvent } from "@deepseek-ai/dsh-session";
/** Hash JSON with stable object-key ordering; array order remains meaningful. */
export function fingerprintJson(value: unknown): string {
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
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
/** Fingerprint every raw event field without changing array order. */
export function fingerprintLog(events: readonly SessionEvent[]): string {
  return fingerprintJson(events);
}
/** Refuse a changed checkpoint even if event counts and surface node offsets still match. */
export function verifyReplay(
  events: readonly SessionEvent[],
  expected: { eventCount: number; surfaceNodes: readonly number[]; eventFingerprint: string },
  projections?: Parameters<typeof foldSurface>[1],
) {
  assert.equal(events.length, expected.eventCount);
  assert.deepEqual(foldSurface(events, projections).nodes, expected.surfaceNodes);
  assert.equal(fingerprintLog(events), expected.eventFingerprint);
}
