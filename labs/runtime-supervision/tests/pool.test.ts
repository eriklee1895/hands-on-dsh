/** Controlled SDK owners expose queue and cleanup ordering without model or process work. */
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RunResult } from "@deepseek-ai/dsh-sdk-client";
import {
  PoolCapacityError,
  PoolClosedError,
  PoolOwnerReuseError,
  PoolQueueAbortedError,
  PoolQueueTimeoutError,
  PoolUnavailableError,
  RuntimePool,
} from "../src/pool.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function result(text: string): RunResult {
  return { sessionId: "session-" + text, finalResponse: text, events: [], notifications: [] };
}

function owner() {
  return {
    run: vi.fn(async (prompt: string) => result(prompt)),
    close: vi.fn(async () => {}),
  };
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error("expected scheduling edge did not occur");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("bounded runtime pool", () => {
  test("validates capacity/deadlines and starts with lazy independent slots", async () => {
    for (const [field, values] of [
      ["size", [0, 33, 1.5]],
      ["maxQueued", [-1, 1025, 0.5]],
      ["activityTimeoutMs", [0, 2 ** 31, NaN]],
      ["queueTimeoutMs", [0, 2 ** 31, Infinity]],
    ] as const) {
      for (const value of values) {
        expect(
          () =>
            new RuntimePool(() => owner(), {
              size: 2,
              maxQueued: 2,
              activityTimeoutMs: 100,
              queueTimeoutMs: 100,
              [field]: value,
            }),
        ).toThrow(field);
      }
    }
    const factory = vi.fn((_slotId: number) => owner());
    const pool = new RuntimePool(factory, {
      size: 2,
      maxQueued: 2,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(pool.snapshot()).toMatchObject({
      state: "open",
      capacity: 2,
      active: 0,
      queued: 0,
      available: 2,
      quarantined: 0,
      slots: [
        { slotId: 1, state: "idle", generation: 0, leased: false },
        { slotId: 2, state: "idle", generation: 0, leased: false },
      ],
    });
    const detached = pool.snapshot();
    Object.assign(detached.slots[0]!, { leased: true });
    expect(pool.snapshot().slots[0]!.leased).toBe(false);
    await pool.close();
  });

  test("reserves two slots, bounds the FIFO, and dispatches oldest work on each release", async () => {
    const gates = new Map(
      ["one", "two", "three", "four"].map((name) => [name, deferred<RunResult>()]),
    );
    const owners = [owner(), owner()];
    for (const item of owners) item.run.mockImplementation((prompt) => gates.get(prompt)!.promise);
    const pool = new RuntimePool((slotId) => owners[slotId - 1]!, {
      size: 2,
      maxQueued: 2,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    const one = pool.run("one");
    const two = pool.run("two");
    const three = pool.run("three");
    const four = pool.run("four");
    await expect(pool.run("overflow")).rejects.toBeInstanceOf(PoolCapacityError);
    expect(pool.snapshot()).toMatchObject({ active: 2, queued: 2, available: 0 });
    await until(
      () => owners[0]!.run.mock.calls.length === 1 && owners[1]!.run.mock.calls.length === 1,
    );
    gates.get("two")!.resolve(result("two"));
    await expect(two).resolves.toMatchObject({ slotId: 2, generation: 1, result: result("two") });
    await until(() => owners[1]!.run.mock.calls.length === 2);
    expect(owners[1]!.run.mock.calls[1]).toEqual(["three"]);
    gates.get("one")!.resolve(result("one"));
    await one;
    await until(() => owners[0]!.run.mock.calls.length === 2);
    expect(owners[0]!.run.mock.calls[1]).toEqual(["four"]);
    gates.get("three")!.resolve(result("three"));
    gates.get("four")!.resolve(result("four"));
    await Promise.all([three, four]);
    expect(pool.snapshot()).toMatchObject({ active: 0, queued: 0, available: 2 });
    await pool.close();
  });

  test("queued abort never creates an owner, while abort after dispatch does not cancel SDK work", async () => {
    const firstWork = deferred<RunResult>();
    const secondWork = deferred<RunResult>();
    const firstOwner = owner();
    firstOwner.run.mockReturnValueOnce(firstWork.promise).mockReturnValueOnce(secondWork.promise);
    const factory = vi.fn(() => firstOwner);
    const pool = new RuntimePool(factory, {
      size: 1,
      maxQueued: 2,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    const already = new AbortController();
    already.abort();
    await expect(pool.run("never", { queueSignal: already.signal })).rejects.toBeInstanceOf(
      PoolQueueAbortedError,
    );
    expect(factory).not.toHaveBeenCalled();
    const first = pool.run("first");
    const waiting = new AbortController();
    const skipped = pool.run("skip", { queueSignal: waiting.signal });
    waiting.abort();
    await expect(skipped).rejects.toBeInstanceOf(PoolQueueAbortedError);
    const dispatchedSignal = new AbortController();
    const second = pool.run("second", { queueSignal: dispatchedSignal.signal });
    firstWork.resolve(result("first"));
    await first;
    await until(() => firstOwner.run.mock.calls.length === 2);
    dispatchedSignal.abort();
    expect(firstOwner.run.mock.calls).toEqual([["first"], ["second"]]);
    secondWork.resolve(result("second"));
    await expect(second).resolves.toMatchObject({ result: result("second") });
    await pool.close();
  });

  test("expires queued work without submitting it; queue timeout is separate from activity", async () => {
    vi.useFakeTimers();
    const work = deferred<RunResult>();
    const owned = owner();
    owned.run.mockReturnValue(work.promise);
    const pool = new RuntimePool(() => owned, {
      size: 1,
      maxQueued: 1,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 50,
    });
    const active = pool.run("active");
    const queued = pool.run("queued");
    const expired = expect(queued).rejects.toBeInstanceOf(PoolQueueTimeoutError);
    await vi.advanceTimersByTimeAsync(50);
    await expired;
    expect(owned.run).toHaveBeenCalledTimes(1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0 });
    work.resolve(result("active"));
    await active;
    await pool.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("dispatch checks monotonic deadline even before a delayed timer fires, then pumps next", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const gate = deferred<RunResult>();
    const owned = owner();
    owned.run.mockReturnValueOnce(gate.promise);
    const pool = new RuntimePool(() => owned, {
      size: 1,
      maxQueued: 2,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 50,
    });
    const active = pool.run("active");
    const expired = pool.run("expired");
    const expiredCheck = expect(expired).rejects.toBeInstanceOf(PoolQueueTimeoutError);
    now = 20;
    const next = pool.run("still valid");
    now = 55;
    gate.resolve(result("active"));
    await active;
    await expiredCheck;
    await expect(next).resolves.toMatchObject({ result: result("still valid") });
    expect(owned.run.mock.calls).toEqual([["active"], ["still valid"]]);
    await pool.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  test("waits for failed-run cleanup before allocating a new generation; never replays failed prompt", async () => {
    const failed = owner();
    const closeGate = deferred<void>();
    failed.run.mockRejectedValue(new Error("transport lost"));
    failed.close.mockReturnValue(closeGate.promise);
    const replacement = owner();
    const factory = vi.fn().mockReturnValueOnce(failed).mockReturnValueOnce(replacement);
    const pool = new RuntimePool(factory, {
      size: 1,
      maxQueued: 1,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    const first = pool.run("possibly acted");
    const checked = expect(first).rejects.toThrow("transport lost");
    const next = pool.run("inspect state");
    await until(() => failed.close.mock.calls.length === 1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 1, available: 0 });
    expect(factory).toHaveBeenCalledTimes(1);
    closeGate.resolve();
    await checked;
    await expect(next).resolves.toMatchObject({ slotId: 1, generation: 2 });
    expect(failed.run.mock.calls).toEqual([["possibly acted"]]);
    expect(replacement.run.mock.calls).toEqual([["inspect state"]]);
    await pool.close();
  });

  test("isolates one failed-close slot and keeps healthy capacity; all unavailable rejects queue", async () => {
    const broken = owner();
    broken.run.mockRejectedValue(new Error("lost"));
    broken.close.mockRejectedValue(new Error("exit unconfirmed"));
    const healthy = owner();
    const healthGate = deferred<RunResult>();
    healthy.run.mockReturnValueOnce(healthGate.promise);
    const pool = new RuntimePool((slotId) => (slotId === 1 ? broken : healthy), {
      size: 2,
      maxQueued: 1,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    const failure = expect(pool.run("broken")).rejects.toBeInstanceOf(AggregateError);
    const active = pool.run("healthy");
    const queued = pool.run("after");
    await failure;
    expect(pool.snapshot()).toMatchObject({ quarantined: 1, active: 1, queued: 1 });
    healthGate.resolve(result("healthy"));
    await active;
    await expect(queued).resolves.toMatchObject({ slotId: 2 });
    expect(healthy.run.mock.calls).toEqual([["healthy"], ["after"]]);
    await expect(pool.close()).rejects.toBeInstanceOf(AggregateError);
    expect(pool.snapshot().state).toBe("close-failed");

    const only = owner();
    only.run.mockRejectedValue(new Error("lost"));
    only.close.mockRejectedValue(new Error("exit unconfirmed"));
    const all = new RuntimePool(() => only, {
      size: 1,
      maxQueued: 1,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    const rejected = expect(all.run("fail")).rejects.toBeInstanceOf(AggregateError);
    const pending = expect(all.run("pending")).rejects.toBeInstanceOf(PoolUnavailableError);
    await Promise.all([rejected, pending]);
    await expect(all.run("new")).rejects.toBeInstanceOf(PoolUnavailableError);
    await expect(all.close()).rejects.toBeInstanceOf(AggregateError);
  });

  test("close is shared, rejects queued work, drains active work, and aggregates failed slot closes", async () => {
    const work = deferred<RunResult>();
    const cleanup = deferred<void>();
    const owned = owner();
    owned.run.mockReturnValue(work.promise);
    owned.close.mockReturnValue(cleanup.promise);
    const pool = new RuntimePool(() => owned, {
      size: 1,
      maxQueued: 1,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    const active = pool.run("active");
    const queued = pool.run("queued");
    const checked = expect(queued).rejects.toBeInstanceOf(PoolClosedError);
    const firstClose = pool.close();
    expect(pool.close()).toBe(firstClose);
    expect(pool.snapshot()).toMatchObject({ state: "closing", active: 1, queued: 0 });
    await expect(pool.run("late")).rejects.toBeInstanceOf(PoolClosedError);
    await checked;
    work.resolve(result("active"));
    await active;
    await until(() => owned.close.mock.calls.length === 1);
    expect(pool.snapshot().state).toBe("closing");
    cleanup.resolve();
    await firstClose;
    expect(pool.snapshot()).toMatchObject({ state: "closed", active: 0, available: 0 });
    expect(owned.close).toHaveBeenCalledTimes(1);
  });

  test("rejects shared and retired SDK owner identities without closing another slot owner", async () => {
    const shared = owner();
    const work = deferred<RunResult>();
    shared.run.mockReturnValue(work.promise);
    const pool = new RuntimePool(() => shared, {
      size: 2,
      maxQueued: 0,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    const first = pool.run("first");
    await expect(pool.run("shared")).rejects.toBeInstanceOf(PoolOwnerReuseError);
    expect(shared.close).not.toHaveBeenCalled();
    expect(pool.snapshot()).toMatchObject({ quarantined: 1, active: 1 });
    work.resolve(result("first"));
    await first;
    await pool.close();
    expect(shared.close).toHaveBeenCalledTimes(1);

    const retired = owner();
    retired.run.mockRejectedValueOnce(new Error("first failed"));
    const same = new RuntimePool(() => retired, {
      size: 1,
      maxQueued: 0,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    await expect(same.run("first")).rejects.toThrow("first failed");
    await expect(same.run("second")).rejects.toBeInstanceOf(PoolOwnerReuseError);
    expect(retired.run).toHaveBeenCalledTimes(1);
    expect(retired.close).toHaveBeenCalledTimes(1);
    await same.close();
  });

  test("reserves a slot before reentrant factory admission and ignores old late completion", async () => {
    const old = owner();
    const late = deferred<RunResult>();
    old.run.mockReturnValue(late.promise);
    const current = owner();
    const currentWork = deferred<RunResult>();
    current.run.mockReturnValue(currentWork.promise);
    let pool!: RuntimePool;
    let nested!: Promise<unknown>;
    const factory = vi.fn((slotId: number) => {
      if (slotId === 1) nested = pool.run("nested");
      return slotId === 1 ? old : current;
    });
    pool = new RuntimePool(factory, {
      size: 2,
      maxQueued: 1,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    const first = pool.run("first");
    await until(() => current.run.mock.calls.length === 1);
    expect(current.run).toHaveBeenCalledWith("nested");
    expect(pool.snapshot()).toMatchObject({ active: 2, available: 0 });
    late.resolve(result("first"));
    await first;
    expect(pool.snapshot()).toMatchObject({ active: 1, available: 1 });
    currentWork.resolve(result("nested"));
    await nested;
    await pool.close();
  });

  test("a timed-out generation's late completion cannot release its replacement lease", async () => {
    vi.useFakeTimers();
    const firstOwner = owner();
    const late = deferred<RunResult>();
    firstOwner.run.mockReturnValue(late.promise);
    const secondOwner = owner();
    const current = deferred<RunResult>();
    secondOwner.run.mockReturnValue(current.promise);
    const factory = vi.fn().mockReturnValueOnce(firstOwner).mockReturnValue(secondOwner);
    const pool = new RuntimePool(factory, {
      size: 1,
      maxQueued: 1,
      activityTimeoutMs: 100,
      queueTimeoutMs: 500,
    });
    const first = expect(pool.run("timed out")).rejects.toThrow("Activity exceeded");
    const queued = pool.run("new explicit work");
    await vi.advanceTimersByTimeAsync(100);
    await first;
    await until(() => secondOwner.run.mock.calls.length === 1);
    expect(pool.snapshot()).toMatchObject({ active: 1, queued: 0, available: 0 });
    late.resolve(result("late"));
    await Promise.resolve();
    expect(pool.snapshot()).toMatchObject({ active: 1, available: 0 });
    current.resolve(result("current"));
    await expect(queued).resolves.toMatchObject({ generation: 2, result: result("current") });
    await pool.close();
  });

  test("close aggregates failures from every slot and keeps a terminal close-failed state", async () => {
    const owners = [owner(), owner()];
    owners[0]!.close.mockRejectedValue(new Error("first exit unconfirmed"));
    owners[1]!.close.mockRejectedValue(new Error("second exit unconfirmed"));
    const pool = new RuntimePool((slotId) => owners[slotId - 1]!, {
      size: 2,
      maxQueued: 0,
      activityTimeoutMs: 1000,
      queueTimeoutMs: 1000,
    });
    await Promise.all([pool.run("one"), pool.run("two")]);
    const closing = pool.close();
    await expect(closing).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "slot 1 close failed" }),
        expect.objectContaining({ message: "slot 2 close failed" }),
      ],
    });
    expect(pool.close()).toBe(closing);
    expect(pool.snapshot().state).toBe("close-failed");
    await expect(pool.run("later")).rejects.toBeInstanceOf(PoolClosedError);
  });
});
