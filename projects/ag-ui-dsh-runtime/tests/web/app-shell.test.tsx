// @vitest-environment jsdom

import { HttpAgent } from "@ag-ui/client";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import type { ButtonHTMLAttributes, ComponentType } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApplicationShell } from "../../src/web/application-shell.tsx";
import { AgentWorkspace, type ChatSurfaceProps } from "../../src/web/agent-workspace.tsx";
import type { Capabilities, ConversationSnapshot, Health } from "../../src/web/api-client.ts";
import type { ConversationHydrator } from "../../src/web/conversation-hydrator.ts";

const capabilities: Capabilities = {
  wireCancel: false,
  approval: false,
  localOnly: true,
  devDirectAgent: true,
  businessReplay: "/api/runs/:id/stream",
};
const health: Health = {
  status: "last-observed",
  runtimeGeneration: 1,
  activeRuns: 0,
};

function snapshot(id: string): ConversationSnapshot {
  return {
    conversation: {
      id,
      title: id === "one" ? "First" : "Second",
      dshSessionRef: `dsh-${id}-g1`,
      sessionGeneration: 1,
      recoveryState: "active",
    },
    messages: [{ id: `message-${id}`, role: "assistant", content: `answer ${id}` }],
    runs: [],
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("ApplicationShell", () => {
  test("presents the direct-development and capability limits as observed status", async () => {
    render(
      <ApplicationShell
        conversations={[snapshot("one").conversation]}
        selectedId="one"
        capabilities={capabilities}
        health={health}
        onSelect={() => undefined}
        onNewConversation={() => undefined}
        onRestart={() => undefined}
        chat={<p>Chat surface</p>}
        inspector={<p>Inspector surface</p>}
      />,
    );

    const capabilityText = screen.getByLabelText("Integration capabilities").textContent ?? "";
    expect(capabilityText).toMatch(/Wire cancel\s*Unsupported/i);
    expect(capabilityText).toMatch(/Approval\s*Unsupported/i);
    expect(capabilityText).toMatch(/Health\s*last-observed/i);
    expect(capabilityText).toMatch(/Direct agent\s*Development only/i);
    expect(screen.getByText(/loopback-only development integration/i)).not.toBeNull();
    expect(screen.getByRole("link", { name: /skip to agent chat/i }).getAttribute("href")).toBe(
      "#agent-chat",
    );
  });

  test("desktop and mobile selectors operate the same chat and Inspector semantics", async () => {
    const select = vi.fn();
    const createConversation = vi.fn();
    const user = userEvent.setup();
    render(
      <ApplicationShell
        conversations={[snapshot("one").conversation, snapshot("two").conversation]}
        selectedId="one"
        capabilities={capabilities}
        health={health}
        onSelect={select}
        onNewConversation={createConversation}
        onRestart={() => undefined}
        chat={<p>Chat surface</p>}
        inspector={<p>Inspector surface</p>}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Second" }));
    await user.selectOptions(screen.getByRole("combobox", { name: /conversation/i }), "two");
    await user.click(screen.getByRole("button", { name: "New conversation (mobile)" }));

    expect(select).toHaveBeenNthCalledWith(1, "two");
    expect(select).toHaveBeenNthCalledWith(2, "two");
    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("main", { name: "Agent chat" }).textContent).toContain("Chat surface");
    expect(screen.getByRole("complementary", { name: "Run Inspector" }).textContent).toContain(
      "Inspector surface",
    );
    expect(screen.getByRole("button", { name: "New conversation" })).not.toBeNull();
    expect(screen.getByRole("button", { name: /restart runtime/i })).not.toBeNull();
  });
});

describe("AgentWorkspace", () => {
  test("unmounts the old chat immediately and mounts the new explicit thread only after hydration", async () => {
    let resolveSecond!: (value: Awaited<ReturnType<ConversationHydrator["select"]>>) => void;
    const second = new Promise<Awaited<ReturnType<ConversationHydrator["select"]>>>((resolve) => {
      resolveSecond = resolve;
    });
    const oneAgent = new HttpAgent({ url: "/api/ag-ui", agentId: "dsh", threadId: "one" });
    oneAgent.setMessages(snapshot("one").messages);
    const twoAgent = new HttpAgent({ url: "/api/ag-ui", agentId: "dsh", threadId: "two" });
    twoAgent.setMessages(snapshot("two").messages);
    const hydrator = {
      select: vi.fn(async (id: string) =>
        id === "one" ? { snapshot: snapshot("one"), agent: oneAgent } : second,
      ),
      dispose: vi.fn(),
    } as unknown as ConversationHydrator;
    const observed: ChatSurfaceProps[] = [];
    const Chat: ComponentType<ChatSurfaceProps> = (props) => {
      observed.push(props);
      return <p>{`chat ${props.threadId}`}</p>;
    };
    const view = render(
      <AgentWorkspace conversationId="one" hydrator={hydrator} ChatSurface={Chat} />,
    );
    await screen.findByText("chat one");

    view.rerender(<AgentWorkspace conversationId="two" hydrator={hydrator} ChatSurface={Chat} />);
    expect(screen.queryByText("chat one")).toBeNull();
    expect(screen.getByRole("status").textContent).toMatch(/loading conversation/i);
    resolveSecond({ snapshot: snapshot("two"), agent: twoAgent });

    await screen.findByText("chat two");
    await waitFor(() => expect(observed.at(-1)).toMatchObject({ agentId: "dsh", threadId: "two" }));
    expect(twoAgent.messages).toEqual(snapshot("two").messages);
    expect(screen.queryByRole("button", { name: /stop receiving.*run continues/i })).toBeNull();
    const input = observed.at(-1)?.input as
      | { sendButton?: ComponentType<ButtonHTMLAttributes<HTMLButtonElement>> }
      | undefined;
    const SendButton = input?.sendButton;
    expect(SendButton).toBeTypeOf("function");
    if (SendButton === undefined) throw new Error("sendButton slot is required");
    view.unmount();
    const button = render(<SendButton onClick={() => undefined} />);
    expect(screen.getByRole("button", { name: "Send message" })).not.toBeNull();
    button.rerender(
      <SendButton onClick={() => undefined}>
        <span>stop glyph</span>
      </SendButton>,
    );
    expect(screen.getByRole("button", { name: "Stop receiving; Run continues" })).not.toBeNull();
  });
});
