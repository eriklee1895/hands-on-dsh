// @vitest-environment jsdom

import { HttpAgent } from "@ag-ui/client";
import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { CopilotKit, useCopilotKit } from "@copilotkit/react-core/v2";
import { ToolRenderers } from "../../src/web/tool-renderers.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ToolRenderers", () => {
  test("registers the proof Zod schema and a wildcard fallback with the real provider", async () => {
    let core: ReturnType<typeof useCopilotKit>["copilotkit"] | undefined;
    const agent = new HttpAgent({
      url: "/api/ag-ui",
      agentId: "dsh",
      threadId: "conversation-1",
    });
    const agents = { dsh: agent };

    function RegistryProbe() {
      const context = useCopilotKit();
      useEffect(() => {
        core = context.copilotkit;
      }, [context]);
      return null;
    }

    render(
      <CopilotKit agents__unsafe_dev_only={agents}>
        <ToolRenderers />
        <RegistryProbe />
      </CopilotKit>,
    );

    await waitFor(() => {
      expect(core?.renderToolCalls.map((renderer) => renderer.name).sort()).toEqual([
        "*",
        "write_stage4_proof",
      ]);
    });
    const proof = core!.renderToolCalls.find((renderer) => renderer.name === "write_stage4_proof");
    expect(proof?.args).toBeDefined();
    const schema = proof!.args as unknown as {
      safeParse(value: unknown): { success: boolean };
    };
    expect(schema.safeParse({ content: "proof" }).success).toBe(true);
    expect(schema.safeParse({ content: 42 }).success).toBe(false);
  });
});
