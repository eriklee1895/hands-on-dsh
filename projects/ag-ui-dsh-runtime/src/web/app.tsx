import type { ComponentType } from "react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ChatSurfaceProps } from "./agent-workspace.tsx";
import {
  ApiClient,
  type Capabilities,
  type ConversationSummary,
  type Health,
} from "./api-client.ts";
import { ApplicationShell } from "./application-shell.tsx";
import { ConversationHydrator } from "./conversation-hydrator.ts";
import { RunInspector } from "./run-inspector.tsx";
import { PersistedRunMonitor, type RunMonitorState } from "./run-monitor.ts";

const browserApi = new ApiClient();
const EMPTY_RUN_STATE: RunMonitorState = { phase: "idle", events: [], cursor: 0 };
const AgentWorkspace = lazy(async () => {
  const module = await import("./agent-workspace.tsx");
  return { default: module.AgentWorkspace };
});

function positivePollInterval(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("pollIntervalMs must be a positive integer");
  return value;
}

export function App({
  api = browserApi,
  monitor: suppliedMonitor,
  ChatSurface,
  idFactory = () => globalThis.crypto.randomUUID(),
  pollIntervalMs = 750,
}: {
  api?: ApiClient;
  monitor?: PersistedRunMonitor;
  ChatSurface?: ComponentType<ChatSurfaceProps>;
  idFactory?: () => string;
  pollIntervalMs?: number;
}) {
  const pollingDelay = positivePollInterval(pollIntervalMs);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [capabilities, setCapabilities] = useState<Capabilities>();
  const [health, setHealth] = useState<Health>();
  const [runtimePhase, setRuntimePhase] = useState<"ready" | "restarting">("ready");
  const [runState, setRunState] = useState<RunMonitorState>(EMPTY_RUN_STATE);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [error, setError] = useState<string>();
  const hydrator = useMemo(
    () =>
      new ConversationHydrator({
        fetchSnapshot: (conversationId, signal) => api.getConversation(conversationId, signal),
      }),
    [api],
  );
  const monitor = useMemo(
    () => suppliedMonitor ?? new PersistedRunMonitor(api),
    [api, suppliedMonitor],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void Promise.all([
      api.listConversations(controller.signal),
      api.getCapabilities(controller.signal),
      api.getHealth(controller.signal),
    ]).then(
      ([loadedConversations, loadedCapabilities, loadedHealth]) => {
        if (!active) return;
        setConversations(loadedConversations);
        setSelectedId((current) => current ?? loadedConversations[0]?.id);
        setCapabilities(loadedCapabilities);
        setHealth(loadedHealth);
      },
      (reason: unknown) => {
        if (active && !controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      active = false;
      controller.abort();
    };
  }, [api]);

  useEffect(() => {
    if (selectedId === undefined) {
      monitor.stop();
      setRunState(EMPTY_RUN_STATE);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let monitoredRunId: string | null | undefined;
    const inspect = async () => {
      try {
        const snapshot = await api.getConversation(selectedId);
        if (!active) return;
        const latest = snapshot.runs.reduce<(typeof snapshot.runs)[number] | undefined>(
          (current, candidate) =>
            current === undefined || candidate.admissionSeq > current.admissionSeq
              ? candidate
              : current,
          undefined,
        );
        const latestId = latest?.id ?? null;
        if (latestId !== monitoredRunId) {
          monitoredRunId = latestId;
          monitor.stop();
          void monitor.watch(snapshot, (state) => {
            if (active) setRunState(state);
          });
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (active) timer = setTimeout(() => void inspect(), pollingDelay);
      }
    };
    void inspect();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      monitor.stop();
    };
  }, [api, monitor, pollingDelay, refreshGeneration, selectedId]);

  const select = (conversationId: string) => {
    setRunState(EMPTY_RUN_STATE);
    setSelectedId(conversationId);
    setRefreshGeneration((generation) => generation + 1);
  };
  const newConversation = async () => {
    try {
      const id = idFactory();
      const conversation = await api.createConversation(
        id,
        `Conversation ${conversations.length + 1}`,
      );
      setConversations((current) => [...current, conversation]);
      select(conversation.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const restart = async () => {
    setRuntimePhase("restarting");
    try {
      await api.restartRuntime();
      setHealth(await api.getHealth());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRuntimePhase("ready");
    }
  };
  const acknowledge = async () => {
    if (selectedId === undefined) return;
    try {
      const conversation = await api.acknowledgeUnknown(selectedId);
      setConversations((current) =>
        current.map((candidate) => (candidate.id === conversation.id ? conversation : candidate)),
      );
      setRefreshGeneration((generation) => generation + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const chat =
    selectedId === undefined ? (
      <div className="empty-chat">
        <h2>Create a Conversation</h2>
        <p>The direct agent mounts only after an authoritative SQLite snapshot is loaded.</p>
      </div>
    ) : (
      <>
        <div className="chat-panel-heading">
          <div>
            <p className="eyebrow">Selected Conversation</p>
            <h2>{conversations.find((conversation) => conversation.id === selectedId)?.title}</h2>
          </div>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => setRefreshGeneration((generation) => generation + 1)}
          >
            Refresh Conversation
          </button>
        </div>
        <Suspense fallback={<p role="status">Loading chat interface…</p>}>
          <AgentWorkspace
            key={`${selectedId}:${refreshGeneration}`}
            conversationId={selectedId}
            hydrator={hydrator}
            {...(ChatSurface === undefined ? {} : { ChatSurface })}
          />
        </Suspense>
      </>
    );
  const selectedConversation = conversations.find((conversation) => conversation.id === selectedId);

  return (
    <>
      {error === undefined ? null : (
        <div className="global-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)}>
            Dismiss
          </button>
        </div>
      )}
      <ApplicationShell
        conversations={conversations}
        selectedId={selectedId}
        capabilities={capabilities}
        health={health}
        runtimePhase={runtimePhase}
        onSelect={select}
        onNewConversation={() => void newConversation()}
        onRestart={() => void restart()}
        chat={chat}
        inspector={
          <RunInspector
            state={runState}
            recoveryState={selectedConversation?.recoveryState ?? "active"}
            artifactUrl={(artifactId) => api.artifactUrl(artifactId)}
            onAcknowledge={() => void acknowledge()}
          />
        }
      />
    </>
  );
}
