import type { ReactNode } from "react";
import type { Capabilities, ConversationSummary, Health } from "./api-client.ts";

export interface ApplicationShellProps {
  conversations: ConversationSummary[];
  selectedId: string | undefined;
  capabilities: Capabilities | undefined;
  health: Health | undefined;
  runtimePhase?: "ready" | "restarting";
  onSelect(conversationId: string): void;
  onNewConversation(): void;
  onRestart(): void;
  chat: ReactNode;
  inspector: ReactNode;
}

function CapabilityStatus({
  capabilities,
  health,
}: Pick<ApplicationShellProps, "capabilities" | "health">) {
  return (
    <dl className="capability-list" aria-label="Integration capabilities">
      <div>
        <dt>Wire cancel</dt>
        <dd>{capabilities?.wireCancel === false ? "Unsupported" : "Checking"}</dd>
      </div>
      <div>
        <dt>Approval</dt>
        <dd>{capabilities?.approval === false ? "Unsupported" : "Checking"}</dd>
      </div>
      <div>
        <dt>Health</dt>
        <dd>{health?.status ?? "Checking"}</dd>
      </div>
      <div>
        <dt>Direct agent</dt>
        <dd>{capabilities?.devDirectAgent === true ? "Development only" : "Checking"}</dd>
      </div>
    </dl>
  );
}

export function ApplicationShell({
  conversations,
  selectedId,
  capabilities,
  health,
  runtimePhase = "ready",
  onSelect,
  onNewConversation,
  onRestart,
  chat,
  inspector,
}: ApplicationShellProps) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#agent-chat">
        Skip to agent chat
      </a>
      <header className="app-header" aria-busy={runtimePhase === "restarting"}>
        <div>
          <p className="eyebrow">AG-UI · DSH</p>
          <h1>Runtime Workbench</h1>
          <p className="integration-notice">Loopback-only development integration</p>
        </div>
        <button
          className="button button--secondary"
          type="button"
          onClick={onRestart}
          disabled={runtimePhase === "restarting"}
        >
          Restart runtime
        </button>
        <p className="runtime-state" role="status" aria-label="Runtime state">
          {runtimePhase === "restarting" ? "Runtime restarting" : "Runtime control idle"}
        </p>
      </header>

      <div className="mobile-conversation-picker">
        <label htmlFor="mobile-conversation">Conversation</label>
        <div className="mobile-conversation-controls">
          <select
            id="mobile-conversation"
            value={selectedId ?? ""}
            onChange={(event) => onSelect(event.currentTarget.value)}
          >
            <option value="" disabled>
              Select a Conversation
            </option>
            {conversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
          </select>
          <button
            className="button button--quiet"
            type="button"
            onClick={onNewConversation}
            aria-label="New conversation (mobile)"
          >
            New
          </button>
        </div>
      </div>

      <div className="workspace-layout">
        <aside className="conversation-sidebar" aria-label="Conversation navigation">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Workspace</p>
              <h2>Conversations</h2>
            </div>
            <button
              className="button button--quiet"
              type="button"
              onClick={onNewConversation}
              aria-label="New conversation"
            >
              New
            </button>
          </div>
          <nav aria-label="Desktop conversations">
            {conversations.map((conversation) => (
              <button
                className="conversation-link"
                type="button"
                key={conversation.id}
                aria-current={conversation.id === selectedId ? "page" : undefined}
                onClick={() => onSelect(conversation.id)}
              >
                <span>{conversation.title}</span>
                <small aria-hidden="true">{conversation.recoveryState}</small>
              </button>
            ))}
          </nav>
        </aside>

        <main id="agent-chat" className="chat-panel" aria-label="Agent chat" tabIndex={-1}>
          {chat}
        </main>

        <aside className="inspector-panel" aria-label="Run Inspector">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Persisted authority</p>
              <h2>Run Inspector</h2>
            </div>
          </div>
          <CapabilityStatus capabilities={capabilities} health={health} />
          {inspector}
        </aside>
      </div>
    </div>
  );
}
