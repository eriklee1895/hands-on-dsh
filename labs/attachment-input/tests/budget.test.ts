import { it, expect } from "vitest";
import { verifyBudgetTransport } from "../src/verify.ts";
import type { TransportEvidence } from "../src/transport.ts";
const hashes = ["oldest", "retained"];
function report(mode: "reject" | "offload"): TransportEvidence {
  return {
    uploads: [],
    deletedUploads: 0,
    blockedRequests: 0,
    injectedRejections: (mode === "reject"
      ? [hashes[0]!]
      : [hashes[0]!, hashes[1]!, hashes[1]!]
    ).map((sha256) => ({ status: 501, bytes: 1300, sha256 })),
    messages:
      mode === "reject"
        ? []
        : Array.from({ length: 2 }, () => ({
            status: 200,
            fileImages: 0,
            inlineImages: 1,
            fileHashes: [],
            inlineHashes: [hashes[1]!],
          })),
  };
}
it.each(["reject", "offload"] as const)("accepts exact %s budget transport", (mode) => {
  expect(() => verifyBudgetTransport(report(mode), hashes, mode)).not.toThrow();
});
it("refuses a rejected budget that still sent a model request", () => {
  const value = report("reject");
  value.messages = report("offload").messages.slice(0, 1);
  expect(() => verifyBudgetTransport(value, hashes, "reject")).toThrow();
});
it("refuses removing the newer image or restoring the oldest on the next turn", () => {
  for (const turn of [0, 1]) {
    const value = report("offload");
    value.messages[turn]!.inlineHashes = [hashes[0]!];
    expect(() => verifyBudgetTransport(value, hashes, "offload")).toThrow();
  }
});
it("refuses an offload result without the initial failed two-image attempt", () => {
  const value = report("offload");
  value.injectedRejections.shift();
  expect(() => verifyBudgetTransport(value, hashes, "offload")).toThrow();
});
