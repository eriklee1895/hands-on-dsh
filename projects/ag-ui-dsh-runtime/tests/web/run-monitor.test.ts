import { describe, expect, test, vi } from "vitest";
import type { ConversationSnapshot, RunDetail, RunEvent } from "../../src/web/api-client.ts";
import { PersistedRunMonitor, type RunMonitorState } from "../../src/web/run-monitor.ts";

function run(id: string, admissionSeq: number, status: RunDetail["status"]) {
  return {
    id,
    conversationId: "conversation-1",
    admissionSeq,
    request: { message: id },
    fingerprint: `fingerprint-${id}`,
    status,
    dshSessionRef: "dsh-conversation-1-g1",
  };
}

function detail(id: string, status: RunDetail["status"]): RunDetail {
  return {
    ...run(id, id === "latest" ? 2 : 1, status),
    artifacts:
      status === "succeeded"
        ? [
            {
              id: "artifact-1",
              filename: "stage4-proof.txt",
              mediaType: "text/plain",
              size: 5,
              sha256: "a".repeat(64),
            },
          ]
        : [],
    events: `/api/runs/${id}/events`,
  };
}

function event(seq: number, channel: RunEvent["channel"], type: string): RunEvent {
  return {
    runId: "latest",
    seq,
    channel,
    type,
    payload: { status: type },
    createdAt: seq,
  };
}

const snapshot: ConversationSnapshot = {
  conversation: {
    id: "conversation-1",
    title: "Conversation",
    dshSessionRef: "dsh-conversation-1-g1",
    sessionGeneration: 1,
    recoveryState: "active",
  },
  messages: [],
  runs: [run("older", 1, "succeeded"), run("latest", 2, "running")],
};

describe("PersistedRunMonitor", () => {
  test("discovers the latest admitted Run, resumes from its cursor and refreshes terminal artifacts", async () => {
    const states: RunMonitorState[] = [];
    const api = {
      listRunEvents: vi
        .fn<() => Promise<RunEvent[]>>()
        .mockResolvedValueOnce([
          event(1, "business", "queued"),
          event(2, "raw-dsh", "session.event"),
        ])
        .mockResolvedValue([]),
      getRun: vi
        .fn<() => Promise<RunDetail>>()
        .mockResolvedValueOnce(detail("latest", "running"))
        .mockResolvedValueOnce(detail("latest", "succeeded")),
      streamRunEvents: vi.fn(
        async (
          _runId: string,
          _after: number,
          _signal: AbortSignal,
          onEvent: (row: RunEvent) => void,
        ) => {
          onEvent(event(3, "business", "running"));
          onEvent(event(4, "business", "succeeded"));
        },
      ),
    };
    const monitor = new PersistedRunMonitor(api);

    await monitor.watch(snapshot, (state) => states.push(state));

    expect(api.streamRunEvents).toHaveBeenCalledWith(
      "latest",
      2,
      expect.any(AbortSignal),
      expect.any(Function),
    );
    expect(states.some((state) => state.phase === "attached-streaming")).toBe(true);
    expect(states.at(-1)).toMatchObject({
      phase: "persisted-terminal",
      cursor: 4,
      run: { id: "latest", status: "succeeded", artifacts: [{ id: "artifact-1" }] },
    });
    expect(states.at(-1)?.events.map((row) => row.seq)).toEqual([1, 2, 3, 4]);
  });

  test("reconnects from the latest persisted cursor after a detached browser stream", async () => {
    const states: RunMonitorState[] = [];
    const api = {
      listRunEvents: vi
        .fn<() => Promise<RunEvent[]>>()
        .mockResolvedValueOnce([event(1, "business", "running")])
        .mockResolvedValueOnce([event(2, "raw-dsh", "session.event")])
        .mockResolvedValue([]),
      getRun: vi
        .fn<() => Promise<RunDetail>>()
        .mockResolvedValueOnce(detail("latest", "running"))
        .mockResolvedValueOnce(detail("latest", "running"))
        .mockResolvedValueOnce(detail("latest", "running"))
        .mockResolvedValueOnce(detail("latest", "succeeded")),
      streamRunEvents: vi
        .fn<
          (
            runId: string,
            after: number,
            signal: AbortSignal,
            onEvent: (row: RunEvent) => void,
          ) => Promise<void>
        >()
        .mockRejectedValueOnce(new Error("network lost"))
        .mockImplementationOnce(async (_runId, _after, _signal, onEvent) => {
          onEvent(event(3, "business", "succeeded"));
        }),
    };
    const wait = vi.fn(async () => undefined);
    const monitor = new PersistedRunMonitor(api, { wait });

    await monitor.watch(snapshot, (state) => states.push(state));

    expect(states.some((state) => state.phase === "client-detached")).toBe(true);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(api.streamRunEvents.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(states.at(-1)).toMatchObject({
      phase: "persisted-terminal",
      cursor: 3,
      run: { status: "succeeded" },
    });
    expect(states.at(-1)?.events.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(states.find((state) => state.phase === "client-detached")?.error).not.toMatch(/cancel/i);
  });

  test("uses bounded backoff for a persistently detached stream instead of busy-looping", async () => {
    const api = {
      listRunEvents: vi.fn(async (_runId: string, after: number) =>
        after === 0 ? [event(1, "business", "running")] : [],
      ),
      getRun: vi.fn(async () => detail("latest", "running")),
      streamRunEvents: vi.fn(async () => {
        throw new Error("still detached");
      }),
    };
    let monitor!: PersistedRunMonitor;
    const wait = vi.fn(async () => {
      if (wait.mock.calls.length === 3) monitor.stop();
    });
    monitor = new PersistedRunMonitor(api, { wait });

    await monitor.watch(snapshot, () => undefined);

    expect(api.streamRunEvents).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  test("presents execution unknown as its own persisted terminal state", async () => {
    const states: RunMonitorState[] = [];
    const api = {
      listRunEvents: vi.fn(async () => [event(1, "business", "execution_unknown")]),
      getRun: vi.fn(async () => detail("latest", "execution_unknown")),
      streamRunEvents: vi.fn(),
    };
    const monitor = new PersistedRunMonitor(api);

    await monitor.watch({ ...snapshot, runs: [run("latest", 2, "execution_unknown")] }, (state) =>
      states.push(state),
    );

    expect(api.streamRunEvents).not.toHaveBeenCalled();
    expect(states.at(-1)).toMatchObject({ phase: "execution-unknown" });
  });

  test.each([
    ["duplicate", [event(1, "business", "running"), event(1, "business", "running")], [1]],
    ["gap", [event(2, "business", "running")], []],
  ])(
    "rejects a %s cursor page without appending invalid rows or busy-looping",
    async (_name, page, expected) => {
      const states: RunMonitorState[] = [];
      const api = {
        listRunEvents: vi.fn(async () => page),
        getRun: vi.fn(async () => detail("latest", "running")),
        streamRunEvents: vi.fn(),
      };
      let monitor!: PersistedRunMonitor;
      const wait = vi.fn(async () => monitor.stop());
      monitor = new PersistedRunMonitor(api, { wait });

      await monitor.watch(snapshot, (state) => states.push(state));

      expect(states.at(-1)?.phase).toBe("client-detached");
      expect(states.at(-1)?.error).toMatch(/cursor.*not contiguous/i);
      expect(states.at(-1)?.events.map((row) => row.seq)).toEqual(expected);
      expect(api.streamRunEvents).not.toHaveBeenCalled();
      expect(wait).toHaveBeenCalledTimes(1);
    },
  );
});
