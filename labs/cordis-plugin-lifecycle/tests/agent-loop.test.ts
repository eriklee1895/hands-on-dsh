import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import {
  CallId,
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import LlmRuntime from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, test } from "vitest";
import * as listenerPlugin from "../src/plugins/listener.ts";
import * as toolPlugin from "../src/plugins/tool.ts";

const roots: string[] = [];

function textResponse(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

function toolResponse(content: string): StreamChunk[] {
  const id = CallId("stage4-call-1");
  const args = JSON.stringify({ content });
  return [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id, name: "write_stage4_proof", argumentsDelta: args },
    {
      type: "block-end",
      index: 0,
      block: { type: "tool-call", id, name: "write_stage4_proof", arguments: args },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  private readonly script: StreamChunk[][];

  constructor(content: string) {
    super();
    this.script = [toolResponse(content), textResponse("stage4 complete")];
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const next = this.script.shift();
    if (next === undefined) throw new Error("script exhausted");
    yield* next;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("scripted real AgentLoop", () => {
  test("writes exact proof and correlates live then durable tool results", async () => {
    const root = await mkdtemp(join(tmpdir(), "stage4-agent-"));
    roots.push(root);
    const proofPath = join(root, "stage4-proof.txt");
    const auditPath = join(root, "audit.jsonl");
    const content = "stage4 deterministic proof\n";
    await expect(access(proofPath)).rejects.toMatchObject({ code: "ENOENT" });

    const ctx = new Context();
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolRuntime);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    const adapter = new ScriptedAdapter(content);
    ctx.llm.registerAdapter(["scripted"], adapter);
    const toolFiber = ctx.plugin(toolPlugin, { workspaceRoot: root });
    await toolFiber;
    const listenerFiber = ctx.plugin(listenerPlugin, {
      rootSessionId: "stage4-root",
      toolName: "write_stage4_proof",
      auditPath,
      auditOwnerToken: "agent-loop-owner",
    });
    await listenerFiber;

    const agent = ctx.agentLoop.create(
      SessionId("stage4-root"),
      { provider: "scripted", model: "scripted-model" },
      { cwd: root },
    );
    const prompt = createUserMessage({
      content: [{ type: "text", text: "write proof" }],
      source: { kind: "user" },
    });
    const receipt = Promise.withResolvers<void>();
    const stopReceipt = ctx.on("session/event", (session, event) => {
      if (
        session === agent.session &&
        event.type === "agent/inbox/spliced" &&
        event.data.inserted.some((message) => message.id === prompt.id)
      )
        receipt.resolve();
    });
    agent.followup(prompt);
    await receipt.promise;
    stopReceipt();
    await agent.whenIdle();

    const schema = adapter.requests[0]?.tools?.find((tool) => tool.name === "write_stage4_proof");
    expect(schema).toEqual({
      name: "write_stage4_proof",
      description: "Write deterministic proof content to the deployment-configured proof artifact.",
      parameters: {
        type: "object",
        properties: { content: { type: "string", description: "Exact proof content" } },
        required: ["content"],
      },
    });
    expect(JSON.stringify(schema)).not.toMatch(/path|command/i);
    expect(await readFile(join(root, "stage4-proof.txt"), "utf8")).toBe(content);
    expect((await stat(join(root, "stage4-proof.txt"))).mode & 0o777).toBe(0o600);
    const result = agent.session.events.find((event) => event.type === "tool/result");
    expect(result?.type === "tool/result" && result.data.message.content[0]?.toolCallId).toBe(
      "stage4-call-1",
    );
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([
      { type: "text", text: "stage4 complete" },
    ]);
    expect(
      (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        kind: "live",
        sessionId: "stage4-root",
        toolName: "write_stage4_proof",
        callId: "stage4-call-1",
      },
      {
        kind: "durable",
        sessionId: "stage4-root",
        toolName: "write_stage4_proof",
        callId: "stage4-call-1",
      },
    ]);
    await listenerFiber.dispose();
    await toolFiber.dispose();
    expect(ctx.tools.get("write_stage4_proof")).toBeUndefined();
    await ctx.fiber.dispose();
  });
});
