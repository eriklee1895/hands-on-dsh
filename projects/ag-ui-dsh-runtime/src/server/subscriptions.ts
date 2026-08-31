import type { AuthoritativeStore, RunEvent } from "./store.js";

export class PersistedSubscriptions {
  private revision = 0;
  private readonly waiters = new Set<() => void>();
  private readonly shutdownController = new AbortController();
  private closed = false;
  activeSubscribers = 0;

  constructor(private readonly store: AuthoritativeStore) {}

  get signal(): AbortSignal {
    return this.shutdownController.signal;
  }

  notify(): void {
    this.revision += 1;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutdownController.abort();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private wait(revision: number, signal?: AbortSignal): Promise<boolean> {
    if (revision !== this.revision) return Promise.resolve(true);
    if (signal?.aborted === true) return Promise.resolve(false);
    return new Promise((resolve) => {
      const cleanup = () => {
        this.waiters.delete(wake);
        signal?.removeEventListener("abort", abort);
      };
      const wake = () => {
        cleanup();
        resolve(true);
      };
      const abort = () => {
        cleanup();
        resolve(false);
      };
      this.waiters.add(wake);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
      else if (revision !== this.revision) wake();
    });
  }

  async *stream(
    runId: string,
    after = 0,
    channel?: RunEvent["channel"],
    signal?: AbortSignal,
  ): AsyncGenerator<RunEvent> {
    if (this.closed) return;
    const combined = new AbortController();
    const abort = () => combined.abort();
    this.shutdownController.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    if (this.shutdownController.signal.aborted || signal?.aborted === true) abort();
    this.activeSubscribers += 1;
    let cursor = after;
    try {
      for (;;) {
        if (combined.signal.aborted) return;
        const revision = this.revision;
        const page = this.store.listEvents(runId, cursor, 100);
        for (const event of page) {
          cursor = event.seq;
          if (channel === undefined || event.channel === channel) yield event;
        }
        const run = this.store.getRun(runId);
        if (run === undefined) throw new Error("run not found");
        if (["succeeded", "failed", "execution_unknown"].includes(run.status) && page.length < 100)
          return;
        if (!(await this.wait(revision, combined.signal))) return;
      }
    } finally {
      this.shutdownController.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
      this.activeSubscribers -= 1;
    }
  }
}
