/** Deterministic model faults over the published loop; no external provider requests. */
import assert from "node:assert/strict";
import { fingerprintLog } from "./replay-evidence.ts";
import type { Context } from "@deepseek-ai/cordis";
import {
  createUserMessage,
  LlmAdapter,
  LlmError,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { SessionId, foldSurface } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-compaction";

export const SCENARIOS = [
  "recover-thrown",
  "recover-in-band",
  "budget-exhausted",
  "disabled",
  "no-progress",
  "summary-error",
  "non-overflow",
  "manual-cancel",
  "overflow-cancel",
  "overflow-late-summary",
] as const;
export type Scenario = (typeof SCENARIOS)[number];
const PROVIDER = "lesson-compaction-fault";
const OLD = "OLD_COMPACTION_HISTORY ".repeat(400);
const CHECKPOINT = "Checkpoint: preserve the number 42.";
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class FaultAdapter extends LlmAdapter {
  armed = false;
  readonly requests: GenerateOptions[] = [];
  readonly allConversationRequests: GenerateOptions[] = [];
  readonly summaries: GenerateOptions[] = [];
  readonly entered = deferred();
  readonly gate = deferred();
  cancellationForwarded = false;
  constructor(readonly scenario: Scenario) {
    super();
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 1_000_000 } };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let answer = "READY";
    if (options.purpose !== "compaction") this.allConversationRequests.push(options);
    if (options.purpose === "compaction") {
      this.summaries.push(options);
      this.entered.release();
      if (
        this.scenario === "manual-cancel" ||
        this.scenario === "overflow-cancel" ||
        this.scenario === "overflow-late-summary"
      ) {
        // A controlled late response deliberately ignores abort until released by the caller.
        await this.gate.promise;
        this.cancellationForwarded = options.signal?.aborted === true;
        if (this.scenario === "overflow-cancel") options.signal?.throwIfAborted();
      }
      if (this.scenario === "summary-error") throw new Error("controlled summary failure");
      answer = this.scenario === "no-progress" ? OLD.repeat(4) : CHECKPOINT;
    } else if (this.armed) {
      this.requests.push(options);
      if (this.scenario === "non-overflow")
        throw new LlmError(
          "context window exceeded text without the canonical code",
          "LESSON_OTHER",
        );
      if (this.requests.length === 1 || this.scenario === "budget-exhausted") {
        if (this.scenario === "recover-in-band") {
          yield {
            type: "finish",
            reason: {
              kind: "error",
              failure: { message: "controlled overflow", code: CONTEXT_WINDOW_EXCEEDED_CODE },
            },
          };
          return;
        }
        throw new LlmError("controlled overflow", CONTEXT_WINDOW_EXCEEDED_CODE);
      }
      answer = "RECOVERED";
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: answer };
    yield { type: "block-end", index: 0, block: { type: "text", text: answer } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
function message(text: string) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}
function text(options: GenerateOptions) {
  return JSON.stringify(options.messages);
}
async function entered(adapter: FaultAdapter) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      adapter.entered.promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("summary was not entered")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Drive one scenario and return only metadata after inspecting its real events and model inputs. */
export async function runScenario(ctx: Context, scenario: Scenario, sessionId: string) {
  const adapter = new FaultAdapter(scenario);
  const unregister = ctx.llm.registerAdapter([PROVIDER], adapter);
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    agentOptions: { provider: PROVIDER, model: "fixture", maxTokens: 64 },
  });
  const agent = handle.agent;
  try {
    agent.followup(message(OLD));
    await agent.whenIdle();
    const prefix = [...agent.session.snapshotEvents()];
    const surfaceBefore = [...agent.session.surface.nodes];
    const generation = agent.session.surface.replaceGeneration;
    let maintenanceReleased = false;
    if (scenario === "manual-cancel") {
      const controller = new AbortController();
      const reason = new Error("controlled caller cancellation");
      const running = ctx.compaction.compactNow(agent, controller.signal);
      const rejection = running.then(
        () => {
          throw new Error("cancelled maintenance fulfilled");
        },
        (error: unknown) => error,
      );
      await entered(adapter);
      controller.abort(reason);
      adapter.gate.release();
      assert.equal(await rejection, reason);
      assert.deepEqual(agent.session.surface.nodes, surfaceBefore);
      assert.equal(agent.session.surface.replaceGeneration, generation);
      // Admission must be released so an ordinary follow-up can run after maintenance cancellation.
      const followup = message("AFTER_MANUAL_CANCEL");
      agent.followup(followup);
      await agent.whenIdle();
      assert.equal(
        adapter.allConversationRequests.length,
        2,
        "follow-up reached the model adapter",
      );
      assert.ok(text(adapter.allConversationRequests[1]!).includes("AFTER_MANUAL_CANCEL"));
      assert.ok(
        agent.session
          .snapshotEvents()
          .some((e) => e.type === "user/message" && e.data.id === followup.id),
      );
      maintenanceReleased = true;
    } else {
      adapter.armed = true;
      agent.followup(message("TRIGGER_OVERFLOW"));
      if (scenario === "overflow-cancel" || scenario === "overflow-late-summary") {
        await entered(adapter);
        agent.cancel({ kind: "user" });
        adapter.gate.release();
      }
      await agent.whenIdle();
    }
    const events = [...agent.session.snapshotEvents()];
    assert.deepEqual(events.slice(0, prefix.length), prefix);
    const markers = events.filter(
      (e) =>
        e.type === "compaction/start" ||
        e.type === "compaction/summary" ||
        e.type === "compaction/end",
    );
    const starts = events.filter((e) => e.type === "compaction/start");
    const summaries = events.filter((e) => e.type === "compaction/summary");
    const ends = events.filter((e) => e.type === "compaction/end");
    const successful = [
      "recover-thrown",
      "recover-in-band",
      "budget-exhausted",
      "overflow-late-summary",
    ].includes(scenario);
    const retried = ["recover-thrown", "recover-in-band", "budget-exhausted"].includes(scenario);
    const attempted = !["disabled", "non-overflow"].includes(scenario);
    assert.equal(adapter.summaries.length, attempted ? 1 : 0);
    assert.equal(starts.length, attempted ? 1 : 0);
    assert.equal(ends.length, starts.length);
    assert.equal(summaries.length, successful ? 1 : 0);
    assert.equal(agent.session.surface.replaceGeneration - generation, successful ? 1 : 0);
    if (attempted) {
      assert.equal(starts[0]!.data.compactionId, ends[0]!.data.compactionId);
      assert.equal(starts[0]!.data.turn, scenario === "manual-cancel" ? null : 2);
      assert.ok(starts[0]!.seq < ends[0]!.seq);
      assert.equal(typeof ends[0]!.data.error === "string", !successful);
    }
    const turnEnd = events.filter((e) => e.type === "turn/end").at(-1);
    assert.ok(turnEnd);
    const expectedTerminal = ["recover-thrown", "recover-in-band", "manual-cancel"].includes(
      scenario,
    )
      ? "completed"
      : scenario.startsWith("overflow-")
        ? "aborted"
        : "error";
    assert.equal(turnEnd.data.reason.kind, expectedTerminal);
    assert.equal(turnEnd.data.turn, 2);
    if (turnEnd.data.reason.kind === "error")
      assert.equal(
        turnEnd.data.reason.error.message,
        scenario === "non-overflow"
          ? "context window exceeded text without the canonical code"
          : "controlled overflow",
      );
    if (turnEnd.data.reason.kind === "error")
      assert.equal(
        turnEnd.data.reason.error.code,
        scenario === "non-overflow" ? "LESSON_OTHER" : CONTEXT_WINDOW_EXCEEDED_CODE,
      );
    if (turnEnd.data.reason.kind === "aborted")
      assert.equal(turnEnd.data.reason.reason.kind, "user");
    assert.equal(adapter.requests.length, retried ? 2 : scenario === "manual-cancel" ? 0 : 1);
    if (adapter.requests.length > 0)
      assert.ok(text(adapter.requests[0]!).includes("OLD_COMPACTION_HISTORY"));
    if (retried) {
      const retry = text(adapter.requests[1]!);
      assert.ok(retry.includes(CHECKPOINT));
      assert.ok(!retry.includes("OLD_COMPACTION_HISTORY"));
      assert.ok(retry.includes("TRIGGER_OVERFLOW"));
      const stepStarts = events.filter((e) => e.type === "step/start" && e.data.turn === 2);
      const stepEnds = events.filter((e) => e.type === "step/end" && e.data.turn === 2);
      assert.equal(stepStarts.length, 1);
      assert.equal(stepEnds.length, 1);
      assert.ok(stepStarts[0]!.seq < starts[0]!.seq && ends[0]!.seq < stepEnds[0]!.seq);
    }
    assert.equal(
      JSON.stringify(agent.session.deriveMessages()).includes("OLD_COMPACTION_HISTORY"),
      !successful,
    );
    if (scenario.endsWith("cancel") || scenario === "overflow-late-summary")
      assert.ok(adapter.cancellationForwarded);
    assert.deepEqual(foldSurface(events).nodes, agent.session.surface.nodes);
    return {
      scenario,
      verified: true,
      sessionId,
      terminal: turnEnd.data.reason,
      conversationCalls: adapter.requests.length,
      summaryCalls: adapter.summaries.length,
      replacementDelta: agent.session.surface.replaceGeneration - generation,
      originalPrefixUnchanged: true,
      oldHistoryRetained: !successful,
      maintenanceReleased,
      cancellationForwarded: adapter.cancellationForwarded,
      markerTypes: markers.map((e) => e.type),
      eventCount: events.length,
      eventFingerprint: fingerprintLog(events),
      surfaceNodes: [...agent.session.surface.nodes],
    };
  } finally {
    adapter.gate.release();
    await handle.dispose();
    unregister();
  }
}
