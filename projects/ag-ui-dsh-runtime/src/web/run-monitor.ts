import type { ConversationSnapshot, RunDetail, RunEvent, RunSummary } from "./api-client.ts";

export type RunMonitorPhase =
  | "idle"
  | "loading"
  | "attached-streaming"
  | "client-detached"
  | "persisted-terminal"
  | "execution-unknown";

export interface RunMonitorState {
  phase: RunMonitorPhase;
  run?: RunSummary | RunDetail;
  events: RunEvent[];
  cursor: number;
  error?: string;
}

export interface RunMonitorApi {
  listRunEvents(runId: string, after: number, signal?: AbortSignal): Promise<RunEvent[]>;
  getRun(runId: string, signal?: AbortSignal): Promise<RunDetail>;
  streamRunEvents(
    runId: string,
    after: number,
    signal: AbortSignal,
    onEvent: (event: RunEvent) => void,
  ): Promise<void>;
}

type RetryWait = (delayMs: number, signal: AbortSignal) => Promise<void>;

async function abortableWait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

function terminalPhase(run: RunDetail): RunMonitorPhase | undefined {
  if (run.status === "execution_unknown") return "execution-unknown";
  if (run.status === "succeeded" || run.status === "failed") return "persisted-terminal";
  return undefined;
}

function latestRun(snapshot: ConversationSnapshot): RunSummary | undefined {
  return snapshot.runs.reduce<RunSummary | undefined>(
    (latest, candidate) =>
      latest === undefined || candidate.admissionSeq > latest.admissionSeq ? candidate : latest,
    undefined,
  );
}

export class PersistedRunMonitor {
  private generation = 0;
  private controller: AbortController | undefined;
  private readonly retryDelayMs: number;
  private readonly wait: RetryWait;

  constructor(
    private readonly api: RunMonitorApi,
    options: { retryDelayMs?: number; wait?: RetryWait } = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 750;
    if (!Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 1)
      throw new Error("retryDelayMs must be a positive integer");
    this.wait = options.wait ?? abortableWait;
  }

  async watch(
    snapshot: ConversationSnapshot,
    onState: (state: RunMonitorState) => void,
  ): Promise<void> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const selectedRun = latestRun(snapshot);
    let events: RunEvent[] = [];
    let cursor = 0;
    const current = () => generation === this.generation && !controller.signal.aborted;
    const publish = (state: Omit<RunMonitorState, "events" | "cursor">) => {
      if (current()) onState({ ...state, events: [...events], cursor });
    };
    if (selectedRun === undefined) {
      publish({ phase: "idle" });
      return;
    }
    publish({ phase: "loading", run: selectedRun });
    const loadPersisted = async () => {
      for (;;) {
        const page = await this.api.listRunEvents(selectedRun.id, cursor, controller.signal);
        if (!current()) return false;
        for (const row of page) {
          if (row.runId !== selectedRun.id || row.seq !== cursor + 1)
            throw new Error("persisted Run event cursor is not contiguous");
          events.push(row);
          cursor = row.seq;
        }
        if (page.length < 500) break;
      }
      return true;
    };
    while (current()) {
      let detail: RunDetail | undefined;
      try {
        if (!(await loadPersisted())) return;
        detail = await this.api.getRun(selectedRun.id, controller.signal);
      } catch (error) {
        if (!current()) return;
        publish({
          phase: "client-detached",
          run: selectedRun,
          error: error instanceof Error ? error.message : String(error),
        });
        await this.wait(this.retryDelayMs, controller.signal);
        continue;
      }
      if (!current()) return;
      const beforeStream = terminalPhase(detail);
      if (beforeStream !== undefined) {
        publish({ phase: beforeStream, run: detail });
        return;
      }
      publish({ phase: "attached-streaming", run: detail });
      let streamFailure: unknown;
      try {
        await this.api.streamRunEvents(selectedRun.id, cursor, controller.signal, (row) => {
          if (!current()) return;
          if (row.runId !== selectedRun.id || row.seq !== cursor + 1)
            throw new Error("persisted Run event cursor is not contiguous");
          events = [...events, row];
          cursor = row.seq;
          publish({ phase: "attached-streaming", run: detail });
        });
      } catch (error) {
        streamFailure = error;
      }
      if (!current()) return;
      try {
        if (!(await loadPersisted())) return;
        detail = await this.api.getRun(selectedRun.id, controller.signal);
      } catch (error) {
        streamFailure ??= error;
      }
      if (!current()) return;
      const afterStream = detail === undefined ? undefined : terminalPhase(detail);
      if (afterStream !== undefined) {
        publish({ phase: afterStream, run: detail });
        return;
      }
      const error =
        streamFailure instanceof Error
          ? streamFailure.message
          : streamFailure === undefined
            ? "business stream ended before persisted terminal"
            : String(streamFailure);
      publish({ phase: "client-detached", run: detail ?? selectedRun, error });
      await this.wait(this.retryDelayMs, controller.signal);
    }
  }

  stop(): void {
    this.generation += 1;
    this.controller?.abort();
    this.controller = undefined;
  }
}
