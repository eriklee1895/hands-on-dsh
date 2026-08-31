// @vitest-environment jsdom

import { HttpAgent } from "@ag-ui/client";
import type { Message } from "@ag-ui/core";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { AgentWorkspace } from "../../src/web/agent-workspace.tsx";
import type { ConversationSnapshot } from "../../src/web/api-client.ts";
import type { ConversationHydrator } from "../../src/web/conversation-hydrator.ts";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  document.body.replaceChildren();
});

test("real provider preserves hydrated messages without connect and still submits through HttpAgent", async () => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { threadId: string; runId: string };
    requests.push({ url: String(input), body });
    const frames = [
      { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
      {
        type: "RUN_FINISHED",
        threadId: body.threadId,
        runId: body.runId,
        outcome: { type: "success" },
      },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    return new Response(frames, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  const agent = new HttpAgent({
    url: "/api/ag-ui",
    agentId: "dsh",
    threadId: "conversation-1",
    fetch: fetcher,
  });
  const messages: Message[] = [
    { id: "user-1", role: "user", content: "persisted user" },
    {
      id: "assistant-1",
      role: "assistant",
      content: "persisted assistant",
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: {
            name: "write_stage4_proof",
            arguments: JSON.stringify({ content: "persisted proof" }),
          },
        },
      ],
    },
    {
      id: "tool-1",
      role: "tool",
      toolCallId: "call-1",
      content: JSON.stringify({ isError: false, content: "persisted proof" }),
    },
    { id: "user-2", role: "user", content: "persisted user two" },
    {
      id: "assistant-2",
      role: "assistant",
      content: "persisted assistant two",
      toolCalls: [
        {
          id: "call-2",
          type: "function",
          function: {
            name: "write_stage4_proof",
            arguments: JSON.stringify({ content: "persisted proof two" }),
          },
        },
      ],
    },
    {
      id: "tool-2",
      role: "tool",
      toolCallId: "call-2",
      content: JSON.stringify({ isError: false, content: "persisted proof two" }),
    },
  ];
  agent.setMessages(messages);
  const connect = vi.spyOn(agent, "connectAgent");
  const snapshot: ConversationSnapshot = {
    conversation: {
      id: "conversation-1",
      title: "Hydrated",
      dshSessionRef: "dsh-conversation-1-g1",
      sessionGeneration: 1,
      recoveryState: "active",
    },
    messages,
    runs: [],
  };
  const hydrator = {
    select: vi.fn(async () => ({ agent, snapshot })),
    dispose: vi.fn(),
  } as unknown as ConversationHydrator;
  const user = userEvent.setup();

  render(<AgentWorkspace conversationId="conversation-1" hydrator={hydrator} />);

  await screen.findByText("persisted user", {}, { timeout: 5_000 });
  await screen.findByText("persisted assistant", {}, { timeout: 5_000 });
  await screen.findByText("persisted assistant two", {}, { timeout: 5_000 });
  expect(screen.getAllByLabelText("write_stage4_proof tool call")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "" })).toBeNull();
  expect(connect).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();

  await user.type(
    screen.getByPlaceholderText("Send a task to the selected Conversation"),
    "new prompt",
  );
  await user.click(screen.getByRole("button", { name: "Send message" }));

  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(requests[0]).toMatchObject({
    url: "/api/ag-ui",
    body: { threadId: "conversation-1" },
  });
  expect(requests[0]?.body.messages).toMatchObject([
    { role: "user", content: "persisted user" },
    { role: "assistant", content: "persisted assistant" },
    { role: "tool", toolCallId: "call-1" },
    { role: "user", content: "persisted user two" },
    { role: "assistant", content: "persisted assistant two" },
    { role: "tool", toolCallId: "call-2" },
    { role: "user", content: "new prompt" },
  ]);
});

test("stop reports browser detachment without claiming DSH cancellation and next submit clears it", async () => {
  let aborted = false;
  let call = 0;
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    call += 1;
    if (call === 1)
      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          aborted = true;
          reject(new DOMException("The operation was aborted", "AbortError"));
        };
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        if (init?.signal?.aborted === true) onAbort();
      });
    const body = JSON.parse(String(init?.body)) as { threadId: string; runId: string };
    return new Response(
      [
        { type: "RUN_STARTED", threadId: body.threadId, runId: body.runId },
        {
          type: "RUN_FINISHED",
          threadId: body.threadId,
          runId: body.runId,
          outcome: { type: "success" },
        },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  });
  const agent = new HttpAgent({
    url: "/api/ag-ui",
    agentId: "dsh",
    threadId: "conversation-1",
    fetch: fetcher,
  });
  const snapshot: ConversationSnapshot = {
    conversation: {
      id: "conversation-1",
      title: "Detach",
      dshSessionRef: "dsh-conversation-1-g1",
      sessionGeneration: 1,
      recoveryState: "active",
    },
    messages: [],
    runs: [],
  };
  const hydrator = {
    select: vi.fn(async () => ({ agent, snapshot })),
    dispose: vi.fn(),
  } as unknown as ConversationHydrator;
  const user = userEvent.setup();

  render(<AgentWorkspace conversationId="conversation-1" hydrator={hydrator} />);
  const input = await screen.findByPlaceholderText(
    "Send a task to the selected Conversation",
    {},
    { timeout: 5_000 },
  );
  await user.type(input, "slow prompt");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await user.click(
    await screen.findByRole(
      "button",
      { name: "Stop receiving; Run continues" },
      { timeout: 5_000 },
    ),
  );

  await screen.findByText(
    "Chat stream detached; this did not cancel DSH. Check Run Inspector for the persisted outcome.",
  );
  expect(aborted).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();

  await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).not.toBeNull());
  await user.type(input, "next prompt");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(
    screen.queryByText(
      "Chat stream detached; this did not cancel DSH. Check Run Inspector for the persisted outcome.",
    ),
  ).toBeNull();
});

test("unmount aborts an attached HttpAgent fetch without changing server state", async () => {
  let signal: AbortSignal | undefined;
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  });
  const agent = new HttpAgent({
    url: "/api/ag-ui",
    agentId: "dsh",
    threadId: "conversation-1",
    fetch: fetcher,
  });
  const snapshot: ConversationSnapshot = {
    conversation: {
      id: "conversation-1",
      title: "Unmount",
      dshSessionRef: "dsh-conversation-1-g1",
      sessionGeneration: 1,
      recoveryState: "active",
    },
    messages: [],
    runs: [],
  };
  const hydrator = {
    select: vi.fn(async () => ({ agent, snapshot })),
    dispose: vi.fn(),
  } as unknown as ConversationHydrator;
  const user = userEvent.setup();
  const view = render(<AgentWorkspace conversationId="conversation-1" hydrator={hydrator} />);
  const input = await screen.findByPlaceholderText(
    "Send a task to the selected Conversation",
    {},
    { timeout: 5_000 },
  );
  await user.type(input, "pending prompt");
  await user.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(signal?.aborted).toBe(false);

  view.unmount();

  expect(signal?.aborted).toBe(true);
});
