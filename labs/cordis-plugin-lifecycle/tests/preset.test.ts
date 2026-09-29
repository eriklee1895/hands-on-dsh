import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import AgentPreset from "@deepseek-ai/dsh-agent-preset";
import AgentPresetRegistry from "@deepseek-ai/dsh-agent-preset-registry";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { expect, test } from "vitest";

test("public preset declares a scoped proof-tool composition without a sandbox promise", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "stage4-preset-"));
  const ctx = new Context();
  ctx.baseUrl = pathToFileURL(join(import.meta.dirname, "..")).href + "/";
  try {
    await ctx.plugin(Loader);
    await ctx.plugin(SessionProjections);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentPresetRegistry, { default: "proof-only" });
    await ctx.plugin(AgentPreset, {
      id: "proof-only",
      name: "Proof only",
      plugins: [
        {
          id: "proof-tool",
          name: "@hands-on-dsh/cordis-plugin-lifecycle/tool",
          config: { workspaceRoot: workspace },
        },
      ],
    });
    expect(await ctx.agentPresets.resolve("proof-only")).toEqual({ id: "proof-only" });
    expect(JSON.stringify(await ctx.agentPresets.compositionInventory())).toContain(
      "@hands-on-dsh/cordis-plugin-lifecycle/tool",
    );
    expect(ctx.tools.get("write_stage4_proof")).toBeUndefined();
  } finally {
    await ctx.fiber.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});
