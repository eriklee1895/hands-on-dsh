import type { RunDetail } from "./api-client.ts";
import type { RunMonitorState } from "./run-monitor.ts";
import type { RecoveryState } from "../shared/domain.ts";

function phaseLabel(state: RunMonitorState, recoveryState: RecoveryState): string {
  if (state.phase === "idle") return "No persisted Run yet";
  if (state.phase === "loading") return "Loading persisted Run";
  if (state.phase === "attached-streaming") return "Attached streaming from business cursor";
  if (state.phase === "client-detached") return "Client detached; persisted Run continues";
  if (state.phase === "execution-unknown")
    return recoveryState === "blocked"
      ? "Execution unknown; acknowledgement required"
      : "Execution unknown acknowledged; session rotated";
  return "Persisted terminal";
}

function hasArtifacts(run: RunMonitorState["run"]): run is RunDetail {
  return run !== undefined && "artifacts" in run;
}

export function RunInspector({
  state,
  recoveryState,
  artifactUrl,
  onAcknowledge,
}: {
  state: RunMonitorState;
  recoveryState: RecoveryState;
  artifactUrl(artifactId: string): string;
  onAcknowledge(): void;
}) {
  const visibleEvents = state.events.filter((event) => event.channel !== "raw-dsh");
  const rawEvents = state.events.filter((event) => event.channel === "raw-dsh");
  return (
    <div className="run-inspector">
      <p className={`run-state run-state--${state.phase}`} role="status" aria-live="polite">
        {phaseLabel(state, recoveryState)}
      </p>
      {state.error === undefined ? null : <p className="diagnostic">{state.error}</p>}
      {state.run === undefined ? null : (
        <dl className="run-facts">
          <div>
            <dt>Run</dt>
            <dd className="monospace">{state.run.id}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{state.run.status}</dd>
          </div>
          <div>
            <dt>Cursor</dt>
            <dd>{state.cursor}</dd>
          </div>
        </dl>
      )}
      {state.phase === "execution-unknown" && recoveryState === "blocked" ? (
        <button className="button button--warning" type="button" onClick={onAcknowledge}>
          Acknowledge uncertainty
        </button>
      ) : null}
      <section aria-labelledby="timeline-title">
        <h3 id="timeline-title">Timeline</h3>
        {visibleEvents.length === 0 ? (
          <p className="empty-state">No projected events yet.</p>
        ) : (
          <ol className="event-timeline">
            {visibleEvents.map((event) => (
              <li key={event.seq}>
                <span className="event-sequence">{event.seq}</span>
                <span>{event.type}</span>
                <small>{event.channel}</small>
              </li>
            ))}
          </ol>
        )}
      </section>
      {hasArtifacts(state.run) && state.run.artifacts.length > 0 ? (
        <section aria-labelledby="artifacts-title">
          <h3 id="artifacts-title">Artifacts</h3>
          <ul className="artifact-list">
            {state.run.artifacts.map((artifact) => (
              <li key={artifact.id}>
                <a href={artifactUrl(artifact.id)} download={artifact.filename}>
                  {artifact.filename}
                </a>
                <small>{`${artifact.size} bytes · ${artifact.sha256.slice(0, 12)}…`}</small>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <details className="raw-events">
        <summary>{`Raw DSH events (${rawEvents.length})`}</summary>
        {rawEvents.length === 0 ? (
          <p>No raw events persisted.</p>
        ) : (
          <ol>
            {rawEvents.map((event) => (
              <li key={event.seq}>
                <strong>{`${event.seq} · ${event.type}`}</strong>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}
