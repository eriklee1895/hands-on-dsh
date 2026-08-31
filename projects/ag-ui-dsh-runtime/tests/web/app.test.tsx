// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { App } from "../../src/web/app.tsx";
import type { ApiClient, ConversationSnapshot } from "../../src/web/api-client.ts";
import type { ChatSurfaceProps } from "../../src/web/agent-workspace.tsx";
import type { PersistedRunMonitor, RunMonitorState } from "../../src/web/run-monitor.ts";

function snapshot(id: string): ConversationSnapshot {
  return {
    conversation: {
      id,
      title: id === "one" ? "First" : "Second",
      dshSessionRef: `dsh-${id}-g1`,
      sessionGeneration: 1,
      recoveryState: "active",
    },
    messages: [{ id: `assistant-${id}`, role: "assistant", content: `persisted ${id}` }],
    runs: [],
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

test("loads persisted Conversations and keeps new, refresh and restart actions explicit", async () => {
  let finishRestart!: () => void;
  const restart = new Promise<void>((resolve) => {
    finishRestart = resolve;
  });
  const getConversation = vi.fn(async (id: string) => snapshot(id));
  const api = {
    listConversations: vi.fn(async () => [snapshot("one").conversation]),
    getConversation,
    getCapabilities: vi.fn(async () => ({
      wireCancel: false as const,
      approval: false as const,
      localOnly: true as const,
      devDirectAgent: true as const,
      businessReplay: "/api/runs/:id/stream",
    })),
    getHealth: vi.fn(async () => ({
      status: "last-observed" as const,
      runtimeGeneration: 1,
      activeRuns: 0,
    })),
    createConversation: vi.fn(async (id: string) => snapshot(id).conversation),
    restartRuntime: vi.fn(async () => restart),
    acknowledgeUnknown: vi.fn(async (id: string) => snapshot(id).conversation),
    artifactUrl: (id: string) => `/api/artifacts/${id}`,
  } as unknown as ApiClient;
  const watch = vi.fn(
    async (_snapshot: ConversationSnapshot, onState: (state: RunMonitorState) => void) => {
      onState({ phase: "idle", events: [], cursor: 0 });
    },
  );
  const monitor = {
    watch,
    stop: vi.fn(),
  } as unknown as PersistedRunMonitor;
  const Chat = ({ threadId }: ChatSurfaceProps) => <p>{`chat ${threadId}`}</p>;
  const user = userEvent.setup();
  const view = render(
    <App
      api={api}
      monitor={monitor}
      ChatSurface={Chat}
      idFactory={() => "two"}
      pollIntervalMs={60_000}
    />,
  );

  await screen.findByText("chat one", {}, { timeout: 5_000 });
  expect(api.listConversations).toHaveBeenCalledTimes(1);
  expect(monitor.watch).toHaveBeenCalled();

  const hydrationCalls = getConversation.mock.calls.length;
  await user.click(screen.getByRole("button", { name: /refresh conversation/i }));
  await waitFor(() => expect(getConversation.mock.calls.length).toBeGreaterThan(hydrationCalls));

  await user.click(screen.getByRole("button", { name: "New conversation" }));
  await screen.findByText("chat two", {}, { timeout: 5_000 });
  expect(api.createConversation).toHaveBeenCalledWith("two", "Conversation 2");

  const restartButton = screen.getByRole("button", {
    name: /restart runtime/i,
  }) as HTMLButtonElement;
  await user.click(restartButton);
  expect(screen.getByRole("status", { name: /runtime state/i }).textContent).toMatch(
    /runtime restarting/i,
  );
  expect(restartButton.disabled).toBe(true);
  expect(screen.getByRole("banner").getAttribute("aria-busy")).toBe("true");
  finishRestart();
  await waitFor(() =>
    expect(screen.getByRole("status", { name: /runtime state/i }).textContent).toMatch(
      /runtime control idle/i,
    ),
  );
  view.unmount();
  expect(monitor.stop).toHaveBeenCalled();
});

test("clears the previous Run Inspector immediately when selecting another Conversation", async () => {
  const one = snapshot("one");
  one.runs = [
    {
      id: "run-one",
      conversationId: "one",
      admissionSeq: 1,
      request: { message: "one" },
      fingerprint: "fingerprint-one",
      status: "succeeded",
      dshSessionRef: one.conversation.dshSessionRef,
    },
  ];
  const two = snapshot("two");
  const api = {
    listConversations: vi.fn(async () => [one.conversation, two.conversation]),
    getConversation: vi.fn(async (id: string) => (id === "one" ? one : two)),
    getCapabilities: vi.fn(async () => ({
      wireCancel: false as const,
      approval: false as const,
      localOnly: true as const,
      devDirectAgent: true as const,
      businessReplay: "/api/runs/:id/stream",
    })),
    getHealth: vi.fn(async () => ({
      status: "last-observed" as const,
      runtimeGeneration: 1,
      activeRuns: 0,
    })),
    artifactUrl: (id: string) => `/api/artifacts/${id}`,
  } as unknown as ApiClient;
  const monitor = {
    watch: vi.fn(async (current: ConversationSnapshot, onState) => {
      if (current.conversation.id === "one")
        onState({
          phase: "persisted-terminal",
          run: { ...one.runs[0]!, artifacts: [], events: "/api/runs/run-one/events" },
          events: [],
          cursor: 0,
        });
    }),
    stop: vi.fn(),
  } as unknown as PersistedRunMonitor;
  const Chat = ({ threadId }: ChatSurfaceProps) => <p>{`chat ${threadId}`}</p>;
  const user = userEvent.setup();
  render(<App api={api} monitor={monitor} ChatSurface={Chat} pollIntervalMs={60_000} />);
  await screen.findByText("run-one", {}, { timeout: 5_000 });

  await user.click(screen.getByRole("button", { name: "Second" }));

  expect(screen.queryByText("run-one")).toBeNull();
});

test("rejects a non-positive Run discovery interval", () => {
  expect(() => render(<App pollIntervalMs={0} />)).toThrow(/pollIntervalMs.*positive/);
});

test("polling discovers a newly admitted higher-sequence Run after empty hydration", async () => {
  let current = snapshot("one");
  const getConversation = vi.fn(async () => current);
  const api = {
    listConversations: vi.fn(async () => [current.conversation]),
    getConversation,
    getCapabilities: vi.fn(async () => ({
      wireCancel: false as const,
      approval: false as const,
      localOnly: true as const,
      devDirectAgent: true as const,
      businessReplay: "/api/runs/:id/stream",
    })),
    getHealth: vi.fn(async () => ({
      status: "last-observed" as const,
      runtimeGeneration: 1,
      activeRuns: 0,
    })),
    artifactUrl: (id: string) => `/api/artifacts/${id}`,
  } as unknown as ApiClient;
  const watch = vi.fn(
    async (_snapshot: ConversationSnapshot, onState: (state: RunMonitorState) => void) => {
      onState({ phase: "idle", events: [], cursor: 0 });
    },
  );
  const monitor = {
    watch,
    stop: vi.fn(),
  } as unknown as PersistedRunMonitor;
  const Chat = ({ threadId }: ChatSurfaceProps) => <p>{`chat ${threadId}`}</p>;
  const view = render(<App api={api} monitor={monitor} ChatSurface={Chat} pollIntervalMs={10} />);
  await waitFor(() => expect(watch).toHaveBeenCalled());
  expect(watch.mock.calls[0]?.[0].runs).toEqual([]);

  current = {
    ...current,
    runs: [
      {
        id: "older-run",
        conversationId: "one",
        admissionSeq: 1,
        request: { message: "older" },
        fingerprint: "older-fingerprint",
        status: "succeeded",
        dshSessionRef: current.conversation.dshSessionRef,
      },
      {
        id: "new-run",
        conversationId: "one",
        admissionSeq: 2,
        request: { message: "new" },
        fingerprint: "new-fingerprint",
        status: "running",
        dshSessionRef: current.conversation.dshSessionRef,
      },
    ],
  };

  await waitFor(
    () =>
      expect(
        watch.mock.calls.some(([observed]) => observed.runs.some((run) => run.id === "new-run")),
      ).toBe(true),
    { timeout: 2_000 },
  );
  view.unmount();
});
