/** Own one SDK runtime without replaying failed work. */
import type { RunResult } from "@deepseek-ai/dsh-sdk-client";

/** SDK operations owned by this experiment. */
export interface OwnedRuntime {
  run(prompt: string): Promise<RunResult>;
  close(): Promise<void>;
}

/** A deadline does not establish whether the model or a tool already acted. */
export class ActivityTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Activity exceeded ${timeoutMs}ms; execution outcome is unknown`);
    this.name = "ActivityTimeoutError";
  }
}

/** Resource state, independent of model outcomes and business Run state. */
export type SupervisorState = "idle" | "running" | "stopping" | "quarantined" | "closed";

/** One runtime slot. A failed close permanently blocks replacement. */
export class RuntimeSupervisor {
  private currentState: SupervisorState = "idle";
  private currentGeneration = 0;
  private owned: OwnedRuntime | undefined;
  private cleanup: Promise<void> | undefined;
  private stopRequested = false;
  private interrupt: ((reason: Error) => void) | undefined;

  /**
   * @param factory Creates an SDK owner without starting unrelated work.
   * @param activityTimeoutMs Positive timer duration, including lazy SDK startup.
   */
  constructor(
    private readonly factory: () => OwnedRuntime,
    private readonly activityTimeoutMs: number,
  ) {
    if (
      !Number.isInteger(activityTimeoutMs) ||
      activityTimeoutMs < 1 ||
      activityTimeoutMs > 2 ** 31 - 1
    ) {
      throw new RangeError("activityTimeoutMs must be an integer between 1 and 2147483647");
    }
  }

  /** Current admission and resource state. */
  get state(): SupervisorState {
    return this.currentState;
  }

  /** Number of SDK owners constructed; not a durable runtime identity. */
  get generation(): number {
    return this.currentGeneration;
  }

  /**
   * Run one SDK activity interval, rejecting concurrent input.
   * @param prompt Explicit new input, never automatically replayed after failure.
   * @returns The unchanged SDK result, whose events may include a model error.
   */
  async run(prompt: string): Promise<RunResult> {
    if (this.currentState === "quarantined")
      throw new Error("Runtime is quarantined; exit was not confirmed");
    if (this.stopRequested) throw new Error("Supervisor is closed");
    if (this.currentState !== "idle") throw new Error("Runtime is busy");
    this.currentState = "running";
    try {
      if (this.owned === undefined) {
        this.owned = this.factory();
        this.currentGeneration += 1;
      }
    } catch (error) {
      this.currentState = "idle";
      throw error;
    }
    const owned = this.owned;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      this.interrupt = reject;
    });
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ActivityTimeoutError(this.activityTimeoutMs)),
        this.activityTimeoutMs,
      );
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (this.stopRequested) throw new Error("Supervisor is closed");
          return owned.run(prompt);
        }),
        interrupted,
        deadline,
      ]);
      if (this.stopRequested) throw new Error("Supervisor is closed");
      return result;
    } catch (error) {
      try {
        await this.disposeCurrent();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Activity failed and runtime exit is unconfirmed",
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      this.interrupt = undefined;
      if (
        this.currentState === "running" ||
        (this.currentState === "stopping" && this.owned === undefined)
      )
        this.currentState = "idle";
    }
  }

  /** Stop admission, interrupt active waiting, and await the SDK's shared close. */
  async close(): Promise<void> {
    this.stopRequested = true;
    this.interrupt?.(new Error("Supervisor is closed; active execution outcome is unknown"));
    await this.disposeCurrent();
  }

  private disposeCurrent(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup;
    if (this.owned === undefined) {
      this.currentState = this.stopRequested ? "closed" : "idle";
      return Promise.resolve();
    }
    const owned = this.owned;
    this.currentState = "stopping";
    this.cleanup = Promise.resolve()
      .then(() => owned.close())
      .then(
        () => {
          this.owned = undefined;
          this.cleanup = undefined;
          this.currentState = this.stopRequested ? "closed" : "stopping";
        },
        (error: unknown) => {
          this.currentState = "quarantined";
          throw error;
        },
      );
    return this.cleanup;
  }
}
