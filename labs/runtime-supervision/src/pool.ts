/** Bounded FIFO capacity around independent, owned RuntimeSupervisor slots. */
import { performance } from "node:perf_hooks";
import type { RunResult } from "@deepseek-ai/dsh-sdk-client";
import { RuntimeSupervisor, type OwnedRuntime, type SupervisorState } from "./supervisor.ts";

export type PoolState = "open" | "closing" | "closed" | "close-failed";

export interface PoolOptions {
  readonly size: number;
  readonly maxQueued: number;
  readonly activityTimeoutMs: number;
  readonly queueTimeoutMs: number;
}

export interface PoolRunOptions {
  /** Aborts only while waiting in the queue; it never cancels dispatched work. */
  readonly queueSignal?: AbortSignal;
}

export interface PoolRunResult {
  readonly slotId: number;
  readonly generation: number;
  readonly result: RunResult;
}

export interface PoolSlotSnapshot {
  readonly slotId: number;
  readonly state: SupervisorState;
  readonly generation: number;
  readonly leased: boolean;
}

export interface PoolSnapshot {
  readonly state: PoolState;
  readonly capacity: number;
  readonly active: number;
  readonly queued: number;
  readonly available: number;
  readonly quarantined: number;
  readonly slots: PoolSlotSnapshot[];
}

export class PoolCapacityError extends Error {
  constructor() {
    super("Runtime pool queue capacity is exhausted");
    this.name = "PoolCapacityError";
  }
}
export class PoolQueueTimeoutError extends Error {
  constructor() {
    super("Runtime pool queue deadline expired");
    this.name = "PoolQueueTimeoutError";
  }
}
export class PoolQueueAbortedError extends Error {
  constructor() {
    super("Runtime pool queue wait was aborted");
    this.name = "PoolQueueAbortedError";
  }
}
export class PoolClosedError extends Error {
  constructor() {
    super("Runtime pool is closed to new work");
    this.name = "PoolClosedError";
  }
}
export class PoolUnavailableError extends Error {
  constructor() {
    super("All runtime pool slots are unavailable");
    this.name = "PoolUnavailableError";
  }
}
export class PoolOwnerReuseError extends Error {
  constructor(readonly slotId: number) {
    super("Runtime pool factory reused an SDK owner for slot " + slotId);
    this.name = "PoolOwnerReuseError";
  }
}

interface Slot {
  readonly slotId: number;
  readonly supervisor: RuntimeSupervisor;
  lease: object | undefined;
  blocked: boolean;
}

interface Pending {
  readonly prompt: string;
  readonly deadline: number;
  readonly resolve: (value: PoolRunResult) => void;
  readonly reject: (reason: Error) => void;
  readonly queueSignal: AbortSignal | undefined;
  readonly onAbort: () => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  waiting: boolean;
}

function validInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(name + " must be an integer between " + minimum + " and " + maximum);
  }
}

/** Owns a fixed number of lazy SDK slots and the waiting requests behind them. */
export class RuntimePool {
  private readonly slots: Slot[];
  private readonly pending: Pending[] = [];
  private readonly seenOwners = new WeakSet<OwnedRuntime>();
  private readonly maxQueued: number;
  private readonly queueTimeoutMs: number;
  private currentState: PoolState = "open";
  private pumping = false;
  private closeTask: Promise<void> | undefined;
  private closeResolve: (() => void) | undefined;
  private closeReject: ((reason: Error) => void) | undefined;
  private closeStarted = false;

  constructor(factory: (slotId: number) => OwnedRuntime, options: PoolOptions) {
    validInteger(options.size, 1, 32, "size");
    validInteger(options.maxQueued, 0, 1024, "maxQueued");
    validInteger(options.activityTimeoutMs, 1, 2 ** 31 - 1, "activityTimeoutMs");
    validInteger(options.queueTimeoutMs, 1, 2 ** 31 - 1, "queueTimeoutMs");
    this.maxQueued = options.maxQueued;
    this.queueTimeoutMs = options.queueTimeoutMs;
    this.slots = Array.from({ length: options.size }, (_, index) => {
      const slotId = index + 1;
      return {
        slotId,
        lease: undefined,
        blocked: false,
        supervisor: new RuntimeSupervisor(() => {
          const owned = factory(slotId);
          if (this.seenOwners.has(owned)) throw new PoolOwnerReuseError(slotId);
          this.seenOwners.add(owned);
          return owned;
        }, options.activityTimeoutMs),
      };
    });
  }

  /** Submit new work, waiting behind earlier requests only when no slot is available. */
  run(prompt: string, options: PoolRunOptions = {}): Promise<PoolRunResult> {
    if (this.currentState !== "open") return Promise.reject(new PoolClosedError());
    if (options.queueSignal?.aborted) return Promise.reject(new PoolQueueAbortedError());
    if (this.allUnavailable()) return Promise.reject(new PoolUnavailableError());
    if (this.pending.length > 0) this.pump();
    const slot = this.pending.length === 0 ? this.availableSlot() : undefined;
    if (slot !== undefined) {
      return new Promise((resolve, reject) => {
        this.dispatch(slot, prompt, resolve, reject);
      });
    }
    if (this.pending.length >= this.maxQueued) return Promise.reject(new PoolCapacityError());
    return new Promise((resolve, reject) => {
      const signal = options.queueSignal;
      const entry: Pending = {
        prompt,
        deadline: performance.now() + this.queueTimeoutMs,
        resolve,
        reject,
        queueSignal: signal,
        onAbort: () => this.removePending(entry, new PoolQueueAbortedError()),
        timer: undefined,
        waiting: true,
      };
      this.pending.push(entry);
      entry.timer = setTimeout(
        () => this.removePending(entry, new PoolQueueTimeoutError()),
        this.queueTimeoutMs,
      );
      signal?.addEventListener("abort", entry.onAbort, { once: true });
      if (signal?.aborted) entry.onAbort();
      this.pump();
    });
  }

  /** Return detached counters and per-slot resource state. */
  snapshot(): PoolSnapshot {
    const slots = this.slots.map((slot): PoolSlotSnapshot => ({
      slotId: slot.slotId,
      state: this.slotState(slot),
      generation: slot.supervisor.generation,
      leased: slot.lease !== undefined,
    }));
    return {
      state: this.currentState,
      capacity: this.slots.length,
      active: slots.filter((slot) => slot.leased).length,
      queued: this.pending.length,
      available:
        this.currentState === "open"
          ? slots.filter((slot) => !slot.leased && slot.state === "idle").length
          : 0,
      quarantined: slots.filter((slot) => slot.state === "quarantined").length,
      slots,
    };
  }

  /** Close admission now, then wait for activity and close every supervisor once. */
  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask;
    this.currentState = "closing";
    const task = new Promise<void>((resolve, reject) => {
      this.closeResolve = resolve;
      this.closeReject = reject;
    });
    this.closeTask = task;
    for (const entry of this.pending.splice(0)) {
      this.detachPending(entry);
      entry.reject(new PoolClosedError());
    }
    this.maybeCloseDrained();
    return task;
  }

  private slotState(slot: Slot): SupervisorState {
    return slot.blocked ? "quarantined" : slot.supervisor.state;
  }

  private allUnavailable(): boolean {
    return this.slots.every((slot) => this.slotState(slot) === "quarantined");
  }

  private availableSlot(): Slot | undefined {
    return this.slots.find((slot) => slot.lease === undefined && this.slotState(slot) === "idle");
  }

  private dispatch(
    slot: Slot,
    prompt: string,
    resolve: (value: PoolRunResult) => void,
    reject: (reason: Error) => void,
  ): void {
    const ticket = {};
    slot.lease = ticket;
    void slot.supervisor.run(prompt).then(
      (result) => {
        this.release(slot, ticket);
        resolve({ slotId: slot.slotId, generation: slot.supervisor.generation, result });
      },
      (reason: unknown) => {
        if (reason instanceof PoolOwnerReuseError) slot.blocked = true;
        this.release(slot, ticket);
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      },
    );
  }

  private release(slot: Slot, ticket: object): void {
    if (slot.lease !== ticket) return;
    slot.lease = undefined;
    if (this.currentState === "open") this.pump();
    else this.maybeCloseDrained();
  }

  private detachPending(entry: Pending): void {
    entry.waiting = false;
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.queueSignal?.removeEventListener("abort", entry.onAbort);
  }

  private removePending(entry: Pending, reason: Error): void {
    if (!entry.waiting) return;
    const index = this.pending.indexOf(entry);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.detachPending(entry);
    entry.reject(reason);
    if (this.currentState === "open") this.pump();
  }

  private pump(): void {
    if (this.pumping || this.currentState !== "open") return;
    this.pumping = true;
    try {
      while (this.pending.length > 0) {
        if (this.allUnavailable()) {
          for (const entry of this.pending.splice(0)) {
            this.detachPending(entry);
            entry.reject(new PoolUnavailableError());
          }
          return;
        }
        const slot = this.availableSlot();
        if (slot === undefined) return;
        const entry = this.pending.shift()!;
        this.detachPending(entry);
        if (entry.queueSignal?.aborted) {
          entry.reject(new PoolQueueAbortedError());
          continue;
        }
        if (performance.now() >= entry.deadline) {
          entry.reject(new PoolQueueTimeoutError());
          continue;
        }
        this.dispatch(slot, entry.prompt, entry.resolve, entry.reject);
      }
    } finally {
      this.pumping = false;
    }
  }

  private maybeCloseDrained(): void {
    if (this.currentState !== "closing" || this.closeStarted) return;
    if (this.slots.some((slot) => slot.lease !== undefined)) return;
    this.closeStarted = true;
    void Promise.allSettled(this.slots.map((slot) => slot.supervisor.close())).then((results) => {
      const errors = results.flatMap((result, index) =>
        result.status === "rejected"
          ? [
              new Error("slot " + this.slots[index]!.slotId + " close failed", {
                cause: result.reason,
              }),
            ]
          : [],
      );
      if (errors.length > 0) {
        this.currentState = "close-failed";
        this.closeReject!(new AggregateError(errors, "Runtime pool close failed"));
      } else {
        this.currentState = "closed";
        this.closeResolve!();
      }
    });
  }
}
