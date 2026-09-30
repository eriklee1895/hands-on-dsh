/** Real published services; only the model response source is controlled. */
import { Context } from "@deepseek-ai/cordis";
import Llm, { LlmAdapter, type GenerateOptions, type StreamChunk } from "@deepseek-ai/dsh-llm";
import Sessions from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Agents from "@deepseek-ai/dsh-agent";
import Loop from "@deepseek-ai/dsh-agent-loop";
import Query from "@deepseek-ai/dsh-session-query-sqlite";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import Subagents from "@deepseek-ai/dsh-subagent";
import * as Spawn from "@deepseek-ai/dsh-subagent-spawn-in-process";
import Fs from "@deepseek-ai/dsh-fs-local";
import Subprocess from "@deepseek-ai/dsh-subprocess-local";
import Sandbox from "@deepseek-ai/dsh-sandbox-local";
import Policy from "@deepseek-ai/dsh-sandbox-policy";
import Ptc from "@deepseek-ai/dsh-ptc-runtime-node";
import Workflow from "@deepseek-ai/dsh-workflow-ptc";

export class FixtureModel extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const text = "CONTROLLED";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export async function fixture(root: string, model = new FixtureModel()) {
  const ctx = new Context();
  try {
    for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents])
      await ctx.plugin(plugin);
    await ctx.plugin(Persistence, { root: root + "/sessions", compression: "none" });
    await ctx.plugin(Query, { path: ":memory:", openAt: "never" });
    await ctx.plugin(Loop, { agents: [] });
    await ctx.plugin(Subagents);
    await ctx.plugin(Spawn);
    for (const plugin of [Fs, Subprocess, Sandbox]) await ctx.plugin(plugin);
    await ctx.plugin(Policy, { mode: "danger-full-access", workspaceRoot: root });
    await ctx.plugin(Ptc, { graceMs: 50 });
    await ctx.plugin(Workflow, { maxConcurrentAgents: 2, maxTotalAgents: 2 });
    ctx.effect(() => ctx.llm.registerAdapter(["fixture"], model));
    return { ctx, model };
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
