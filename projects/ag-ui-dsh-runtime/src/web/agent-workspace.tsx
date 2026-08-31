import {
  CopilotChatConfigurationProvider,
  CopilotChatInput,
  CopilotChatView,
  CopilotKit,
  UseAgentUpdate,
  type CopilotChatProps,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-core/v2";
import type { ButtonHTMLAttributes, ComponentType } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationHydrator, HydratedConversation } from "./conversation-hydrator.ts";
import { ToolRenderers } from "./tool-renderers.tsx";

export type ChatSurfaceProps = Pick<CopilotChatProps, "agentId" | "threadId" | "input" | "labels">;

function AccessibleSendButton(props: ButtonHTMLAttributes<HTMLButtonElement>) {
  const label = props.children === undefined ? "Send message" : "Stop receiving; Run continues";
  return <CopilotChatInput.SendButton {...props} aria-label={label} title={label} />;
}

function HiddenAttachmentsButton(): null {
  return null;
}

function BoundChatView() {
  const { agent, isReady } = useAgent({
    agentId: "dsh",
    updates: [UseAgentUpdate.OnMessagesChanged, UseAgentUpdate.OnRunStatusChanged],
  });
  const { copilotkit } = useCopilotKit();
  const [inputValue, setInputValue] = useState("");
  const [submissionError, setSubmissionError] = useState<string>();
  const [receptionNotice, setReceptionNotice] = useState<string>();
  useEffect(
    () => () => {
      agent.abortRun();
    },
    [agent],
  );
  const submit = useCallback(
    async (value: string) => {
      if (value.trim() === "" || agent.isRunning) return;
      setInputValue("");
      setSubmissionError(undefined);
      setReceptionNotice(undefined);
      agent.addMessage({
        id: globalThis.crypto.randomUUID(),
        role: "user",
        content: value,
      });
      try {
        await copilotkit.runAgent({ agent });
      } catch (error) {
        if (!(error instanceof Error && error.name === "AbortError"))
          setSubmissionError(error instanceof Error ? error.message : String(error));
      }
    },
    [agent, copilotkit],
  );
  const stopReception = useCallback(() => {
    agent.abortRun();
    setReceptionNotice(
      "Chat stream detached; this did not cancel DSH. Check Run Inspector for the persisted outcome.",
    );
  }, [agent]);
  return (
    <>
      {submissionError === undefined ? null : (
        <p role="alert">{`Message submission failed: ${submissionError}`}</p>
      )}
      {receptionNotice === undefined ? null : (
        <p className="chat-reception-notice" role="status">
          {receptionNotice}
        </p>
      )}
      <CopilotChatView
        messages={[...agent.messages]}
        isRunning={agent.isRunning}
        onSubmitMessage={isReady ? (value) => void submit(value) : undefined}
        onStop={stopReception}
        inputValue={inputValue}
        onInputChange={setInputValue}
        input={{
          sendButton: AccessibleSendButton,
          addMenuButton: HiddenAttachmentsButton,
        }}
        hasExplicitThreadId
      />
    </>
  );
}

function HydratedAgentChat({
  conversationId,
  hydrated,
  ChatSurface,
}: {
  conversationId: string;
  hydrated: HydratedConversation;
  ChatSurface?: ComponentType<ChatSurfaceProps>;
}) {
  const agents = useMemo(() => ({ dsh: hydrated.agent }), [hydrated.agent]);
  return (
    <CopilotKit key={conversationId} agents__unsafe_dev_only={agents} enableInspector={false}>
      <ToolRenderers />
      <CopilotChatConfigurationProvider
        agentId="dsh"
        threadId={conversationId}
        hasExplicitThreadId
        labels={{ chatInputPlaceholder: "Send a task to the selected Conversation" }}
      >
        {ChatSurface === undefined ? (
          <BoundChatView />
        ) : (
          <ChatSurface
            agentId="dsh"
            threadId={conversationId}
            input={{ sendButton: AccessibleSendButton }}
            labels={{ chatInputPlaceholder: "Send a task to the selected Conversation" }}
          />
        )}
      </CopilotChatConfigurationProvider>
    </CopilotKit>
  );
}

export function AgentWorkspace({
  conversationId,
  hydrator,
  ChatSurface,
}: {
  conversationId: string;
  hydrator: ConversationHydrator;
  ChatSurface?: ComponentType<ChatSurfaceProps>;
}) {
  const [hydrated, setHydrated] = useState<HydratedConversation>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setError(undefined);
    setHydrated(undefined);
    void hydrator.select(conversationId).then(
      (selection) => {
        if (active && selection !== undefined) setHydrated(selection);
      },
      (reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [conversationId, hydrator]);

  useEffect(
    () => () => {
      hydrator.dispose();
    },
    [hydrator],
  );

  if (error !== undefined) return <p role="alert">{`Conversation hydration failed: ${error}`}</p>;
  if (hydrated?.snapshot.conversation.id !== conversationId)
    return <p role="status">Loading Conversation from SQLite…</p>;
  return (
    <HydratedAgentChat
      conversationId={conversationId}
      hydrated={hydrated}
      ChatSurface={ChatSurface}
    />
  );
}
