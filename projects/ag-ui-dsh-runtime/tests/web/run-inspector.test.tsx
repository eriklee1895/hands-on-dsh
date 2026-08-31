// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { RunInspector } from "../../src/web/run-inspector.tsx";
import type { RunDetail, RunEvent } from "../../src/web/api-client.ts";

const running: RunDetail = {
  id: "run-1",
  conversationId: "conversation-1",
  admissionSeq: 1,
  request: { message: "proof" },
  fingerprint: "fingerprint",
  status: "running",
  dshSessionRef: "dsh-conversation-1-g1",
  artifacts: [],
  events: "/api/runs/run-1/events",
};
const events: RunEvent[] = [
  {
    runId: "run-1",
    seq: 1,
    channel: "business",
    type: "running",
    payload: { status: "running" },
    createdAt: 1,
  },
  {
    runId: "run-1",
    seq: 2,
    channel: "raw-dsh",
    type: "session.event",
    payload: { event: "step/start" },
    createdAt: 2,
  },
];

afterEach(() => {
  document.body.replaceChildren();
});

test("distinguishes attached, detached, terminal and execution-unknown persisted states", async () => {
  const acknowledge = vi.fn();
  const user = userEvent.setup();
  const view = render(
    <RunInspector
      state={{ phase: "attached-streaming", run: running, events, cursor: 2 }}
      recoveryState="active"
      artifactUrl={(id) => `/api/artifacts/${id}`}
      onAcknowledge={acknowledge}
    />,
  );

  expect(screen.getByRole("status").textContent).toMatch(/attached streaming/i);
  expect(screen.getAllByText(/running/i)).toHaveLength(2);
  const rawDisclosure = screen.getByText(/Raw DSH events/i).closest("details");
  expect(rawDisclosure?.open).toBe(false);
  await user.click(screen.getByText(/Raw DSH events/i));
  expect(rawDisclosure?.open).toBe(true);
  expect(screen.getByText(/step\/start/i)).not.toBeNull();

  view.rerender(
    <RunInspector
      state={{
        phase: "client-detached",
        run: running,
        events,
        cursor: 2,
        error: "network lost",
      }}
      recoveryState="active"
      artifactUrl={(id) => `/api/artifacts/${id}`}
      onAcknowledge={acknowledge}
    />,
  );
  expect(screen.getByRole("status").textContent).toMatch(/client detached.*Run continues/i);

  view.rerender(
    <RunInspector
      state={{
        phase: "persisted-terminal",
        run: {
          ...running,
          status: "succeeded",
          artifacts: [
            {
              id: "artifact-1",
              filename: "stage4-proof.txt",
              mediaType: "text/plain",
              size: 5,
              sha256: "a".repeat(64),
            },
          ],
        },
        events,
        cursor: 2,
      }}
      recoveryState="active"
      artifactUrl={(id) => `/api/artifacts/${id}`}
      onAcknowledge={acknowledge}
    />,
  );
  expect(screen.getByRole("status").textContent).toMatch(/persisted terminal/i);
  expect(screen.getByRole("link", { name: /stage4-proof.txt/i }).getAttribute("href")).toBe(
    "/api/artifacts/artifact-1",
  );

  view.rerender(
    <RunInspector
      state={{
        phase: "execution-unknown",
        run: { ...running, status: "execution_unknown" },
        events,
        cursor: 2,
      }}
      recoveryState="blocked"
      artifactUrl={(id) => `/api/artifacts/${id}`}
      onAcknowledge={acknowledge}
    />,
  );
  expect(screen.getByRole("status").textContent).toMatch(/execution unknown/i);
  await user.click(screen.getByRole("button", { name: /acknowledge uncertainty/i }));
  expect(acknowledge).toHaveBeenCalledTimes(1);

  view.rerender(
    <RunInspector
      state={{
        phase: "execution-unknown",
        run: { ...running, status: "execution_unknown" },
        events,
        cursor: 2,
      }}
      recoveryState="active"
      artifactUrl={(id) => `/api/artifacts/${id}`}
      onAcknowledge={acknowledge}
    />,
  );
  expect(screen.getByRole("status").textContent).toMatch(/acknowledged.*session rotated/i);
  expect(screen.queryByRole("button", { name: /acknowledge uncertainty/i })).toBeNull();
});
