/** Evidence required before calling an overflow a remote provider rejection. */
import assert from "node:assert/strict";
export function verifyRemoteOverflow(evidence: {
  statuses: number[];
  terminalKind: string;
  errorCode?: string;
  toolCalls: number;
  responseText: string;
}): void {
  assert.equal(evidence.statuses.length, 1, "one bounded remote attempt");
  assert.ok(
    evidence.statuses[0] === 400 || evidence.statuses[0] === 413,
    "remote endpoint must reject the request",
  );
  assert.equal(evidence.terminalKind, "error");
  assert.equal(evidence.errorCode, "CONTEXT_WINDOW_EXCEEDED");
  assert.equal(evidence.toolCalls, 0);
  assert.equal(evidence.responseText, "");
}

/** Save reduced transport evidence and release its listener even if saving fails. */
export async function saveAndCloseTransport(
  path: string,
  evidence: object,
  close: () => Promise<void>,
) {
  const { writeFile } = await import("node:fs/promises");
  try {
    await writeFile(path, JSON.stringify(evidence), { mode: 0o600 });
  } finally {
    await close();
  }
}
