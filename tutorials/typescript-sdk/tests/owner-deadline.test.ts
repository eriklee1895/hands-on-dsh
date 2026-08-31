import { describe, expect, test } from "vitest";
import { withOwnerDeadline } from "../src/owner-deadline.ts";

describe("withOwnerDeadline", () => {
  test("keeps the deadline as the deterministic winner when close rejects the operation", async () => {
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const owner = {
      close: async () => {
        rejectOperation(new Error("transport closed first"));
      },
    };

    await expect(
      withOwnerDeadline("deterministic turn", 10, owner, () => operation),
    ).rejects.toThrow(/deterministic turn exceeded the 10ms receipt-to-idle deadline/);
  });

  test("waits for delayed close before returning the deadline failure", async () => {
    let closed = false;
    const started = Date.now();
    const owner = {
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        closed = true;
      },
    };

    await expect(
      withOwnerDeadline("slow close", 10, owner, () => new Promise<never>(() => {})),
    ).rejects.toThrow(/slow close exceeded the 10ms receipt-to-idle deadline/);
    expect(closed).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
  });

  test("aggregates the deadline and close failures after close settles", async () => {
    const closeError = new Error("close diagnostics");
    const owner = { close: async () => Promise.reject(closeError) };

    const error = await withOwnerDeadline(
      "failed close",
      10,
      owner,
      () => new Promise<never>(() => {}),
    ).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AggregateError);
    const failures = (error as AggregateError).errors as unknown[];
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      message: expect.stringMatching(/failed close exceeded the 10ms receipt-to-idle deadline/),
    });
    expect(failures[1]).toBe(closeError);
  });

  test("calls close once while allowing the caller's idempotent finally close", async () => {
    let closeCalls = 0;
    let rejectOperation!: (error: Error) => void;
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    let closeTask: Promise<void> | undefined;
    const owner = {
      close: () => {
        closeCalls += 1;
        closeTask ??= Promise.resolve().then(() => rejectOperation(new Error("closed")));
        return closeTask;
      },
    };

    await expect(withOwnerDeadline("repeat close", 10, owner, () => operation)).rejects.toThrow(
      /repeat close exceeded the 10ms receipt-to-idle deadline/,
    );
    await owner.close();
    expect(closeCalls).toBe(2);
  });
});
