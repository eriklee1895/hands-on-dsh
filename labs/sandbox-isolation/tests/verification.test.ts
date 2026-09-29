import { describe, expect, it } from "vitest";
import { validateReport } from "../src/verification.ts";

const input = {
  workspace: "/workspace",
  outside: "/outside",
  temp: "/temp",
  url: "http://127.0.0.1:1234",
  parentPid: 123,
  nonce: "proof",
};
function report() {
  return {
    nonce: input.nonce,
    operations: {
      insideWrite: { status: "allowed" },
      outsideRead: { status: "allowed", value: "proof" },
      outsideWrite: { status: "denied", code: "EPERM" },
      symlinkWrite: { status: "denied", code: "EPERM" },
      descendantWrite: { status: "denied", code: "EPERM" },
      tempWrite: { status: "allowed" },
      loopback: { status: "allowed", value: "proof" },
      parentVisible: { status: "allowed" },
    },
  };
}
describe("evidence validation", () => {
  it("accepts only the complete expected matrix and exact canary", () => {
    expect(validateReport(report(), input, "workspace-write").nonce).toBe("proof");
    expect(() => validateReport(report(), input, "read-only")).toThrow();
    expect(() =>
      validateReport({ ...report(), nonce: "wrong" }, input, "workspace-write"),
    ).toThrow();
    expect(() => validateReport({}, input, "workspace-write")).toThrow();
  });
  it("does not count a broken path or missing field as a sandbox denial", () => {
    const broken = report();
    broken.operations.outsideWrite.code = "ENOENT";
    expect(() => validateReport(broken, input, "workspace-write")).toThrow();
    const missing = report();
    Reflect.deleteProperty(missing.operations, "loopback");
    expect(() => validateReport(missing, input, "workspace-write")).toThrow();
  });
});
