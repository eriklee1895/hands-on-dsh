import assert from "node:assert/strict";
import type { Color } from "./fixture.ts";
export function verifyAnswer(answer: string, expected: readonly (readonly Color[])[]): void {
  assert.deepEqual(
    JSON.parse(answer),
    expected,
    "vision answer must match every cell of every image",
  );
}

/** Check the two-turn experiment's wire mode, image order and injected failure coverage. */
export function verifyTransport(
  evidence: import("./transport.ts").TransportEvidence,
  hashes: readonly string[],
  policy: import("./transport.ts").FilesPolicy,
): void {
  assert.equal(hashes.length, 2);
  assert.equal(evidence.messages.length, 2);
  const inline = policy !== "forward";
  for (const request of evidence.messages) {
    assert.equal(request.status, 200);
    assert.equal(
      request.fileImages,
      inline ? 0 : 2,
      "whole request must use the expected representation",
    );
    assert.equal(request.inlineImages, inline ? 2 : 0);
    assert.deepEqual(request.fileHashes, inline ? [] : hashes);
    assert.deepEqual(request.inlineHashes, inline ? hashes : []);
  }
  const uploadHashes =
    policy === "forward" ? hashes : policy === "reject-after-first" ? hashes.slice(0, 1) : [];
  assert.deepEqual(
    evidence.uploads.map((upload) => upload.sha256),
    uploadHashes,
  );
  for (const upload of evidence.uploads) {
    assert.ok(upload.status >= 200 && upload.status < 300);
    assert.equal(upload.acknowledged, true);
  }
  const rejectedHash = hashes[policy === "reject-all" ? 0 : 1];
  assert.deepEqual(
    evidence.injectedRejections.map((rejection) => ({
      status: rejection.status,
      sha256: rejection.sha256,
    })),
    inline
      ? [
          { status: 501, sha256: rejectedHash },
          { status: 501, sha256: rejectedHash },
        ]
      : [],
  );
  assert.equal(
    evidence.blockedRequests,
    0,
    "fixture refusal is separate from an unauthorized route",
  );
}
