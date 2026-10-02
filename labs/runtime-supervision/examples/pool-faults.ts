/** Controlled failures demonstrate admission and ownership without starting DSH. */
import assert from "node:assert/strict";
import type { RunResult } from "@deepseek-ai/dsh-sdk-client";
import { RuntimePool, PoolCapacityError, PoolQueueAbortedError } from "../src/pool.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const first = deferred<RunResult>();
const second = deferred<RunResult>();
const started: string[] = [];
const closed: number[] = [];
let owners = 0;
const fixture = (text: string): RunResult => ({
  sessionId: "fixture-" + text,
  finalResponse: text,
  events: [],
  notifications: [],
});
const pool = new RuntimePool(
  () => {
    const ownerId = ++owners;
    return {
      async run(prompt) {
        started.push(prompt);
        if (prompt === "A") return first.promise;
        if (prompt === "B") return second.promise;
        return fixture(prompt);
      },
      async close() {
        closed.push(ownerId);
      },
    };
  },
  { size: 2, maxQueued: 2, activityTimeoutMs: 5000, queueTimeoutMs: 5000 },
);
const abort = new AbortController();
const disconnected = new Error("simulated transport failure");
try {
  const a = pool.run("A");
  const b = pool.run("B").catch((error: unknown) => error);
  const c = pool.run("C");
  const d = pool.run("D", { queueSignal: abort.signal }).catch((error: unknown) => error);
  // Attach handlers before changing any controlled promise.
  const completed = Promise.all([a, b, c, d]);
  void completed.catch(() => {});
  const admitted = pool.snapshot();
  assert.equal(admitted.active, 2);
  assert.equal(admitted.queued, 2);
  await assert.rejects(pool.run("E"), PoolCapacityError);
  abort.abort();
  assert.ok((await d) instanceof PoolQueueAbortedError);
  second.reject(disconnected);
  assert.equal(await b, disconnected);
  const replacement = await c;
  assert.equal(replacement.slotId, 2);
  assert.equal(replacement.generation, 2);
  assert.deepEqual(closed, [2]);
  first.resolve(fixture("A"));
  await completed;
  await pool.close();
  assert.deepEqual(started, ["A", "B", "C"]);
  assert.equal(owners, 3);
  assert.equal(new Set(closed).size, 3);
  assert.equal(pool.snapshot().state, "closed");
  console.log(
    JSON.stringify(
      {
        kind: "controlled-fixture",
        admitted: { active: admitted.active, queued: admitted.queued },
        capacityRejected: true,
        queuedAbort: true,
        started,
        replacement: { slotId: replacement.slotId, generation: replacement.generation },
        ownersCreated: owners,
        ownersClosed: closed.length,
        replayed: false,
      },
      null,
      2,
    ),
  );
} finally {
  first.resolve(fixture("A"));
  second.resolve(fixture("B"));
  await pool.close();
}
