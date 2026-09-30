import { afterEach, describe, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Llm, { LlmAdapter, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import Sessions, { SessionId } from "@deepseek-ai/dsh-session";
import Projections from "@deepseek-ai/dsh-session-projection";
import Prompt from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";
import Agents from "@deepseek-ai/dsh-agent";
import Loop from "@deepseek-ai/dsh-agent-loop";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";

const MODEL = "fixture";
const SIGNAL = new AbortController().signal;
const OLD_NOISE = "UNRELATED_OLD_CONTEXT ".repeat(400);
const SUMMARY = "Checkpoint: keep the durable goal.";

class FixtureAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  failSummary = false;

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 100_000 } };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    if (options.purpose === "compaction" && this.failSummary)
      throw new Error("controlled summary failure");
    const answer = options.purpose === "compaction" ? SUMMARY : "retained tail answer";
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: answer };
    yield { type: "block-end", index: 0, block: { type: "text", text: answer } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
});

async function fixture(auto = false) {
  const ctx = new Context();
  contexts.push(ctx);
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents])
    await ctx.plugin(plugin);
  await ctx.plugin(Loop, { agents: [] });
  await ctx.plugin(TokenMeter);
  const adapter = new FixtureAdapter();
  ctx.effect(() => ctx.llm.registerAdapter([MODEL], adapter));
  const compact = new BasicCompactionEngine(ctx, {
    auto,
    thresholdRatio: 0.005,
    headroomTokens: 0,
    retainTokens: 0,
    maxTokens: 64,
    compactionRetries: 0,
    maxOverflowRetries: 0,
  });
  const handle = await ctx.agents.create({
    sessionId: SessionId("compaction-fixture"),
    agentOptions: { provider: MODEL, model: MODEL },
  });
  ctx.effect(() => () => handle.dispose());
  return { ctx, adapter, compact, agent: handle.agent };
}

function message(text: string) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

function textOf(
  messages: readonly { content: readonly { type: string; text?: string }[] }[],
): string {
  return messages
    .flatMap((item) =>
      item.content.map((block) => (block.type === "text" ? (block.text ?? "") : "")),
    )
    .join("\n");
}

describe("published BasicCompactionEngine", () => {
  it("compacts at pressure before the next request while retaining the waking input", async () => {
    const { agent, adapter } = await fixture(true);
    agent.followup(message(OLD_NOISE));
    await agent.whenIdle();

    agent.followup(message("new task after old context"));
    await agent.whenIdle();

    const events = agent.session.snapshotEvents();
    expect(events.filter((event) => event.type === "compaction/summary")).toHaveLength(1);
    const next = adapter.requests.filter((request) => request.purpose !== "compaction").at(-1);
    expect(textOf(next?.messages ?? [])).toContain(SUMMARY);
    expect(textOf(next?.messages ?? [])).toContain("new task after old context");
    expect(textOf(next?.messages ?? [])).not.toContain(OLD_NOISE);
  });

  it("returns no-op for an empty idle surface without writing a bracket", async () => {
    const { agent, compact, adapter } = await fixture();
    const before = agent.session.snapshotEvents();

    expect(await compact.compactNow(agent, SIGNAL)).toBeNull();
    expect(agent.session.snapshotEvents()).toEqual(before);
    expect(adapter.requests).toHaveLength(0);
  });

  it("commits a real maintenance bracket and reuses the checkpoint in the next model request", async () => {
    const { agent, compact, adapter } = await fixture();
    agent.followup(message(OLD_NOISE));
    await agent.whenIdle();
    const prefix = [...agent.session.snapshotEvents()];
    const old = prefix.find(
      (event) =>
        event.type === "user/message" &&
        JSON.stringify(event.data).includes("UNRELATED_OLD_CONTEXT"),
    );
    expect(old).toBeDefined();

    const result = await compact.compactNow(agent, SIGNAL);

    if (result === null) throw new Error("expected a committed compaction");
    const events = agent.session.snapshotEvents();
    expect(events.slice(0, prefix.length)).toEqual(prefix);
    const markers = events.filter((event) => event.type.startsWith("compaction/"));
    expect(markers.map((event) => event.type)).toEqual([
      "compaction/start",
      "compaction/summary",
      "compaction/end",
    ]);
    const summary = events.find((event) => event.type === "compaction/summary");
    expect(summary?.type === "compaction/summary" && summary.data.shadowedSeqs).toContain(old?.seq);
    expect(summary?.type === "compaction/summary" && summary.data.llmStreamCall).toBe(true);
    const replacement = events.find(
      (event) =>
        event.type === "user/message" &&
        typeof event.surfaceOp === "object" &&
        event.surfaceOp.op === "replace",
    );
    expect(replacement).toMatchObject({
      surfaceOp: {
        op: "replace",
        startSeq: result.shadowedRange.start,
        endSeq: result.shadowedRange.end,
      },
    });
    expect(replacement?.sourceEventSeqs).toContain(result.summarySeq);
    expect(textOf(agent.session.deriveMessages())).toContain(SUMMARY);
    expect(textOf(agent.session.deriveMessages())).not.toContain(OLD_NOISE);

    agent.followup(message("continue after checkpoint"));
    await agent.whenIdle();
    const nextRequest = adapter.requests.at(-1);
    expect(nextRequest?.purpose).not.toBe("compaction");
    expect(textOf(nextRequest?.messages ?? [])).toContain(SUMMARY);
    expect(textOf(nextRequest?.messages ?? [])).not.toContain(OLD_NOISE);
  });

  it("closes a failed summary attempt without replacing the surface", async () => {
    const { agent, compact, adapter } = await fixture();
    agent.followup(message(OLD_NOISE));
    await agent.whenIdle();
    const prefix = [...agent.session.snapshotEvents()];
    const surface = [...agent.session.surface.nodes];
    adapter.failSummary = true;

    await expect(compact.compactNow(agent, SIGNAL)).rejects.toMatchObject({
      code: "summary",
    } satisfies Partial<ManualCompactionError>);

    const events = agent.session.snapshotEvents();
    expect(events.slice(0, prefix.length)).toEqual(prefix);
    expect(
      events.filter((event) => event.type.startsWith("compaction/")).map((event) => event.type),
    ).toEqual(["compaction/start", "compaction/end"]);
    expect(agent.session.surface.nodes).toEqual(surface);
    expect(textOf(agent.session.deriveMessages())).toContain(OLD_NOISE);
  });
});
