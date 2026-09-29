/** Deterministic lifecycle probes; no process, network or model is started. */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunResult } from "@deepseek-ai/dsh-sdk-client";
import { ActivityTimeoutError, RuntimeSupervisor } from "../src/supervisor.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function result(text = "done"): RunResult {
  return { sessionId: "session-test", finalResponse: text, events: [], notifications: [] };
}

function runtime() {
  return { run: vi.fn(async (_prompt: string) => result()), close: vi.fn(async () => {}) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("one owned runtime", () => {
  it("keeps admission closed until failed activity has released its slot", async () => {
    const failed = runtime();
    failed.run.mockRejectedValue(new Error("disconnected"));
    const replacement = runtime();
    const work = deferred<RunResult>();
    replacement.run.mockReturnValue(work.promise);
    const factory = vi.fn().mockReturnValueOnce(failed).mockReturnValue(replacement);
    const supervisor = new RuntimeSupervisor(factory, 1000);
    const first = supervisor.run("first").catch(() => {});
    for (let i = 0; i < 30 && supervisor.state !== "idle"; i += 1) await Promise.resolve();
    expect(supervisor.state).toBe("idle");
    const second = supervisor.run("second");
    await first;
    expect(supervisor.state).toBe("running");
    const rejected = expect(supervisor.run("third")).rejects.toThrow("busy");
    work.resolve(result());
    await Promise.all([second, rejected]);
    await supervisor.close();
  });

  it("starts lazily and reuses a runtime for sequential work", async () => {
    const owned = runtime();
    const factory = vi.fn(() => owned);
    const supervisor = new RuntimeSupervisor(factory, 1000);
    expect(factory).not.toHaveBeenCalled();
    await expect(supervisor.run("first")).resolves.toEqual(result());
    await supervisor.run("second");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(owned.run.mock.calls).toEqual([["first"], ["second"]]);
    expect(supervisor.generation).toBe(1);
    expect(supervisor.state).toBe("idle");
    await supervisor.close();
  });

  it("rejects concurrent input instead of interleaving sessions or queuing it", async () => {
    const owned = runtime();
    const pending = deferred<RunResult>();
    owned.run.mockReturnValue(pending.promise);
    const supervisor = new RuntimeSupervisor(() => owned, 1000);
    const first = supervisor.run("first");
    await expect(supervisor.run("second")).rejects.toThrow("busy");
    pending.resolve(result());
    await first;
    expect(owned.run).toHaveBeenCalledTimes(1);
    await supervisor.close();
  });

  it("closes after failure and only starts another generation for new explicit input", async () => {
    const failed = runtime();
    const next = runtime();
    const failure = new Error("transport lost after possible tool execution");
    failed.run.mockRejectedValue(failure);
    const factory = vi.fn().mockReturnValueOnce(failed).mockReturnValue(next);
    const supervisor = new RuntimeSupervisor(factory, 1000);
    await expect(supervisor.run("side effect")).rejects.toBe(failure);
    expect(failed.close).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(supervisor.state).toBe("idle");
    await supervisor.run("inspect external state");
    expect(factory).toHaveBeenCalledTimes(2);
    expect(next.run).toHaveBeenCalledWith("inspect external state");
    await supervisor.close();
  });

  it("waits for exit confirmation after timeout and ignores a late result", async () => {
    vi.useFakeTimers();
    const owned = runtime();
    const work = deferred<RunResult>();
    const cleanup = deferred<void>();
    owned.run.mockReturnValue(work.promise);
    owned.close.mockReturnValue(cleanup.promise);
    const supervisor = new RuntimeSupervisor(() => owned, 100);
    const pending = supervisor.run("slow");
    const checked = expect(pending).rejects.toBeInstanceOf(ActivityTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    expect(supervisor.state).toBe("stopping");
    await expect(supervisor.run("too early")).rejects.toThrow("busy");
    work.resolve(result("late"));
    await Promise.resolve();
    expect(supervisor.state).toBe("stopping");
    cleanup.resolve();
    await checked;
    expect(supervisor.state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
    await supervisor.close();
  });

  it("quarantines the slot when recovery cannot confirm process exit", async () => {
    const owned = runtime();
    const runError = new Error("run lost");
    const closeError = new Error("exit unconfirmed");
    owned.run.mockRejectedValue(runError);
    owned.close.mockRejectedValue(closeError);
    const factory = vi.fn(() => owned);
    const supervisor = new RuntimeSupervisor(factory, 1000);
    await expect(supervisor.run("act")).rejects.toMatchObject({ errors: [runError, closeError] });
    expect(supervisor.state).toBe("quarantined");
    await expect(supervisor.run("retry")).rejects.toThrow("quarantined");
    await expect(supervisor.close()).rejects.toBe(closeError);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(owned.close).toHaveBeenCalledTimes(1);
  });

  it("shares cleanup when close races active work and refuses all later input", async () => {
    const owned = runtime();
    const work = deferred<RunResult>();
    const cleanup = deferred<void>();
    owned.run.mockReturnValue(work.promise);
    owned.close.mockReturnValue(cleanup.promise);
    const supervisor = new RuntimeSupervisor(() => owned, 1000);
    const run = supervisor.run("active");
    const checked = expect(run).rejects.toThrow("closed");
    await Promise.resolve();
    expect(owned.run).toHaveBeenCalledTimes(1);
    const firstClose = supervisor.close();
    const secondClose = supervisor.close();
    await expect(supervisor.run("later")).rejects.toThrow("closed");
    cleanup.resolve();
    await Promise.all([firstClose, secondClose, checked]);
    expect(owned.close).toHaveBeenCalledTimes(1);
    expect(supervisor.state).toBe("closed");
    work.reject(new Error("late transport EOF"));
    await Promise.resolve();
  });

  it("never launches after an unused supervisor is closed", async () => {
    const factory = vi.fn(() => runtime());
    const supervisor = new RuntimeSupervisor(factory, 1000);
    await supervisor.close();
    await supervisor.close();
    await expect(supervisor.run("no")).rejects.toThrow("closed");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not submit a prompt if closed before lazy execution starts", async () => {
    const owned = runtime();
    const supervisor = new RuntimeSupervisor(() => owned, 1000);
    const pending = supervisor.run("not submitted");
    const checked = expect(pending).rejects.toThrow("closed");
    await supervisor.close();
    await checked;
    expect(owned.run).not.toHaveBeenCalled();
    expect(owned.close).toHaveBeenCalledTimes(1);
  });

  it("clears the activity timer after success", async () => {
    vi.useFakeTimers();
    const owned = runtime();
    const supervisor = new RuntimeSupervisor(() => owned, 100);
    await supervisor.run("fast");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(owned.close).not.toHaveBeenCalled();
    await supervisor.close();
  });

  it("keeps a newer generation intact when timed-out work resolves later", async () => {
    vi.useFakeTimers();
    const first = runtime();
    const late = deferred<RunResult>();
    first.run.mockReturnValue(late.promise);
    const second = runtime();
    const active = deferred<RunResult>();
    second.run.mockReturnValue(active.promise);
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(second);
    const supervisor = new RuntimeSupervisor(factory, 100);
    const timedOut = expect(supervisor.run("first")).rejects.toBeInstanceOf(ActivityTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await timedOut;
    const next = supervisor.run("second");
    late.resolve(result("late"));
    await Promise.resolve();
    expect(supervisor.state).toBe("running");
    expect(supervisor.generation).toBe(2);
    active.resolve(result("current"));
    await expect(next).resolves.toEqual(result("current"));
    await supervisor.close();
  });

  it("preserves timeout and cleanup failure as separate causes", async () => {
    vi.useFakeTimers();
    const owned = runtime();
    owned.run.mockReturnValue(new Promise<RunResult>(() => {}));
    const failure = new Error("exit unconfirmed");
    owned.close.mockRejectedValue(failure);
    const supervisor = new RuntimeSupervisor(() => owned, 100);
    const checked = expect(supervisor.run("slow")).rejects.toMatchObject({
      errors: [expect.any(ActivityTimeoutError), failure],
    });
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(supervisor.state).toBe("quarantined");
  });

  it("does not turn a factory failure into an automatic retry", async () => {
    const error = new Error("invalid launch options");
    const factory = vi.fn(() => {
      throw error;
    });
    const supervisor = new RuntimeSupervisor(factory, 1000);
    await expect(supervisor.run("no")).rejects.toBe(error);
    expect(supervisor.generation).toBe(0);
    expect(supervisor.state).toBe("idle");
    expect(factory).toHaveBeenCalledTimes(1);
    await supervisor.close();
  });

  it("returns the SDK interval unchanged without inventing business success", async () => {
    const owned = runtime();
    const interval = result("");
    owned.run.mockResolvedValue(interval);
    const supervisor = new RuntimeSupervisor(() => owned, 1000);
    expect(await supervisor.run("observe")).toBe(interval);
    expect(owned.close).not.toHaveBeenCalled();
    await supervisor.close();
  });

  it.each([0, -1, NaN, Infinity, 0.5, 2 ** 31])(
    "rejects an invalid activity deadline %s",
    (value) => {
      expect(() => new RuntimeSupervisor(() => runtime(), value)).toThrow("activityTimeoutMs");
    },
  );
});
