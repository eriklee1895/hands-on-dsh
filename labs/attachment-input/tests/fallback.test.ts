import { it, expect } from "vitest";
import { verifyTransport } from "../src/verify.ts";
import type { FilesPolicy, TransportEvidence } from "../src/transport.ts";
const hashes = ["first-image", "second-image"];
function evidence(policy: FilesPolicy): TransportEvidence {
  const uploaded =
    policy === "forward" ? hashes : policy === "reject-after-first" ? hashes.slice(0, 1) : [];
  const rejected =
    policy === "forward"
      ? []
      : Array.from({ length: 2 }, () => hashes[policy === "reject-all" ? 0 : 1]!);
  return {
    staleInvalidations: 0,
    uploads: uploaded.map((sha256) => ({ status: 200, bytes: 10, sha256, acknowledged: true })),
    injectedRejections: rejected.map((sha256) => ({ status: 501, bytes: 10, sha256 })),
    messages: Array.from({ length: 2 }, () => ({
      status: 200,
      fileImages: policy === "forward" ? 2 : 0,
      inlineImages: policy === "forward" ? 0 : 2,
      fileHashes: policy === "forward" ? [...hashes] : [],
      inlineHashes: policy === "forward" ? [] : [...hashes],
    })),
    blockedRequests: 0,
    deletedUploads: 0,
  };
}
it.each(["forward", "reject-all", "reject-after-first"] as const)(
  "accepts complete %s wire evidence",
  (policy) => {
    expect(() => verifyTransport(evidence(policy), hashes, policy)).not.toThrow();
  },
);
it("rejects mixed Files and inline content even when all images are present", () => {
  const report = evidence("reject-after-first");
  report.messages[0] = {
    status: 200,
    fileImages: 1,
    inlineImages: 1,
    fileHashes: hashes.slice(0, 1),
    inlineHashes: hashes.slice(1),
  };
  expect(() => verifyTransport(report, hashes, "reject-after-first")).toThrow();
});
it("rejects image reordering or changed bytes", () => {
  for (const actual of [[...hashes].reverse(), [hashes[0]!, "changed-image"]]) {
    const report = evidence("reject-all");
    report.messages[1]!.inlineHashes = actual;
    expect(() => verifyTransport(report, hashes, "reject-all")).toThrow();
  }
});
it("rejects a fallback claim without the intended upload failure or with extra remote uploads", () => {
  const absent = evidence("reject-all");
  absent.injectedRejections = [];
  expect(() => verifyTransport(absent, hashes, "reject-all")).toThrow();
  const extra = evidence("reject-after-first");
  extra.uploads.push({ ...extra.uploads[0]!, sha256: hashes[1]! });
  expect(() => verifyTransport(extra, hashes, "reject-after-first")).toThrow();
});
it("rejects unresolved remote uploads and unsuccessful model responses", () => {
  const unknown = evidence("reject-after-first");
  unknown.uploads[0]!.acknowledged = false;
  expect(() => verifyTransport(unknown, hashes, "reject-after-first")).toThrow();
  const failed = evidence("reject-all");
  failed.messages[1]!.status = 502;
  expect(() => verifyTransport(failed, hashes, "reject-all")).toThrow();
});

it.each([false, true])("accepts stale-ID recovery with reupload-all=%s", (all) => {
  const value = evidence("forward");
  value.staleInvalidations = 1;
  value.uploads.push(...value.uploads.slice(0, all ? 2 : 1).map((upload) => ({ ...upload })));
  value.messages.unshift({ ...value.messages[0]!, status: 400 });
  expect(() => verifyTransport(value, hashes, "stale-once")).not.toThrow();
});

it("rejects a stale-recovery claim without failed dispatch, owned deletion, or matching repair bytes", () => {
  const base = evidence("forward");
  base.staleInvalidations = 1;
  base.messages.unshift({ ...base.messages[0]!, status: 400 });
  base.uploads.push({ ...base.uploads[0]! });
  const noFailure = structuredClone(base);
  noFailure.messages[0]!.status = 200;
  const noDeletion = structuredClone(base);
  noDeletion.staleInvalidations = 0;
  const wrongRepair = structuredClone(base);
  wrongRepair.uploads[2]!.sha256 = "different";
  const extraRetry = structuredClone(base);
  extraRetry.messages.unshift({ ...extraRetry.messages[0]! });
  for (const value of [noFailure, noDeletion, wrongRepair, extraRetry])
    expect(() => verifyTransport(value, hashes, "stale-once")).toThrow();
});
