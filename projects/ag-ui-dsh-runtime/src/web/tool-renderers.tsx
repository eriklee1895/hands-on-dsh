import { useDefaultRenderTool, useRenderTool } from "@copilotkit/react-core/v2";
import { z } from "zod";

export const ProofToolParameters = z.object({ content: z.string() });

function statusLabel(status: "inProgress" | "executing" | "complete"): string {
  if (status === "inProgress") return "Receiving arguments";
  if (status === "executing") return "Writing proof";
  return "Persisted";
}

export function ToolRenderers(): null {
  useRenderTool(
    {
      name: "write_stage4_proof",
      agentId: "dsh",
      parameters: ProofToolParameters,
      render: ({ status, parameters, result }) => (
        <section className="tool-card tool-card--proof" aria-label="write_stage4_proof tool call">
          <header>
            <strong>Stage 4 proof</strong>
            <span>{statusLabel(status)}</span>
          </header>
          {typeof parameters.content === "string" && parameters.content !== "" ? (
            <p>{parameters.content}</p>
          ) : null}
          {status === "complete" ? <pre>{result}</pre> : null}
        </section>
      ),
    },
    [],
  );
  useDefaultRenderTool(
    {
      render: ({ name, status, parameters, result }) => (
        <section className="tool-card" aria-label={`${name} tool call`}>
          <header>
            <strong>{name}</strong>
            <span>{statusLabel(status)}</span>
          </header>
          <details>
            <summary>Tool details</summary>
            <pre>{JSON.stringify({ parameters, result }, null, 2)}</pre>
          </details>
        </section>
      ),
    },
    [],
  );
  return null;
}
