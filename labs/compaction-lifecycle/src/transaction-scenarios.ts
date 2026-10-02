/** Controlled commit/flush failures and competing maintenance over the published engine. */
import assert from "node:assert/strict";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import type { Context } from "@deepseek-ai/cordis";
import {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ManualCompactionError } from "@deepseek-ai/dsh-compaction";
import type {} from "@deepseek-ai/dsh-agent";
import { fingerprintLog } from "./replay-evidence.ts";
export const TRANSACTION_SCENARIOS = [
  "concurrent-maintenance",
  "flush-before",
  "flush-after",
  "closing-marker",
] as const;
export type TransactionScenario = (typeof TRANSACTION_SCENARIOS)[number];
const PROVIDER = "lesson-transaction";
const OLD = "OLD_TRANSACTION_HISTORY ".repeat(400);
const SUMMARY = "Checkpoint: retain the durable goal.";
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
class TransactionAdapter extends LlmAdapter {
  readonly entered = deferred();
  readonly gate = deferred();
  readonly requests: GenerateOptions[] = [];
  summaryCalls = 0;
  constructor(readonly held: boolean) {
    super();
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: 1000000 } };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let text = "READY";
    if (options.purpose === "compaction") {
      this.summaryCalls++;
      this.entered.release();
      if (this.held) await this.gate.promise;
      text = SUMMARY;
    } else this.requests.push(options);
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
function message(text: string) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}
async function rejection(work: () => Promise<unknown>, code: string) {
  let failure: unknown;
  try {
    await work();
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof ManualCompactionError);
  assert.equal(failure.code, code);
  return failure;
}
async function entered(ready: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("controlled phase entry deadline")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function runTransactionScenario(
  ctx: Context,
  scenario: TransactionScenario,
  sessionId: string,
) {
  const adapter = new TransactionAdapter(scenario === "concurrent-maintenance");
  const unregister = ctx.llm.registerAdapter([PROVIDER], adapter);
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    agentOptions: { provider: PROVIDER, model: "fixture", maxTokens: 64 },
  });
  const agent = handle.agent;
  const originalFlush = ctx.sessions.flush;
  const originalAppend = agent.session.append;
  let operation: Promise<unknown> | undefined;
  let flushCalls = 0;
  let realFlushBeforeError = false;
  let checkpointReadBeforeError = false;
  let errorCode: string | null = null;
  let secondOwnerRefused = false;
  let retryRefused = false;
  const checkpointEntered = deferred(),
    checkpointGate = deferred();
  let followupWaitedForFlush = false;
  try {
    agent.followup(message(OLD));
    await agent.whenIdle();
    await originalFlush.call(ctx.sessions, agent.session);
    const prefix = structuredClone([...agent.session.snapshotEvents()]);
    const generation = agent.session.surface.replaceGeneration;
    if (scenario === "concurrent-maintenance") {
      let held = false;
      ctx.sessions.flush = async (session) => {
        if (
          !held &&
          session.id === agent.session.id &&
          session.snapshotEvents().some((event) => event.type === "compaction/end")
        ) {
          held = true;
          checkpointEntered.release();
          await checkpointGate.promise;
        }
        return originalFlush.call(ctx.sessions, session);
      };
      operation = ctx.compaction.compactNow(agent, new AbortController().signal);
      await entered(adapter.entered.promise);
      await rejection(() => ctx.compaction.compactNow(agent, new AbortController().signal), "busy");
      secondOwnerRefused = true;
      agent.followup(message("AFTER_MAINTENANCE"));
      assert.equal(adapter.requests.length, 1);
      assert.equal(agent.session.snapshotEvents().filter((e) => e.type === "turn/start").length, 1);
      adapter.gate.release();
      await entered(checkpointEntered.promise);
      await nextEventLoopTurn();
      assert.equal(adapter.requests.length, 1);
      assert.equal(
        agent.session.snapshotEvents().filter((event) => event.type === "turn/start").length,
        1,
      );
      followupWaitedForFlush = true;
      checkpointGate.release();
      assert.ok(await operation);
      await agent.whenIdle();
    } else {
      const fault = new Error("controlled " + scenario);
      let armed = true;
      if (scenario === "closing-marker") {
        // Proxy preserves the generic append signature while intercepting one event discriminant.
        agent.session.append = new Proxy(originalAppend, {
          apply(target, receiver, args) {
            if (armed && args[0] === "compaction/end") {
              armed = false;
              throw fault;
            }
            return Reflect.apply(target, receiver, args);
          },
        });
      } else {
        ctx.sessions.flush = async (session) => {
          if (armed && session.id === agent.session.id) {
            armed = false;
            flushCalls++;
            if (scenario === "flush-after") {
              await originalFlush.call(ctx.sessions, session);
              realFlushBeforeError = true;
              const reader = await ctx.sessionPersistence.open(session.id, "read");
              try {
                const stored = (await reader.read()).events;
                assert.deepEqual(stored, session.snapshotEvents());
                assert.ok(
                  stored.some(
                    (event) => event.type === "compaction/end" && event.data.error === undefined,
                  ),
                );
                checkpointReadBeforeError = true;
              } finally {
                await reader.close();
              }
            }
            throw fault;
          }
          return originalFlush.call(ctx.sessions, session);
        };
      }
      const failure = await rejection(
        () => ctx.compaction.compactNow(agent, new AbortController().signal),
        scenario === "closing-marker" ? "commit" : "persistence",
      );
      errorCode = failure.code;
      assert.equal(failure.cause, fault);
      ctx.sessions.flush = originalFlush;
      agent.session.append = originalAppend;
      if (scenario === "closing-marker") {
        await rejection(
          () => ctx.compaction.compactNow(agent, new AbortController().signal),
          "busy",
        );
        retryRefused = true;
      } else {
        // Reconcile explicitly after the injected failure; do not infer rollback from a rejected call.
        await originalFlush.call(ctx.sessions, agent.session);
        agent.followup(message("AFTER_MAINTENANCE"));
        await agent.whenIdle();
      }
    }
    const events = [...agent.session.snapshotEvents()];
    assert.deepEqual(events.slice(0, prefix.length), prefix);
    const starts = events.filter((e) => e.type === "compaction/start");
    const summaries = events.filter((e) => e.type === "compaction/summary");
    const ends = events.filter((e) => e.type === "compaction/end");
    assert.equal(starts.length, 1);
    assert.equal(summaries.length, 1);
    assert.equal(ends.length, scenario === "closing-marker" ? 0 : 1);
    assert.equal(ends[0]?.data.error, undefined);
    assert.equal(adapter.summaryCalls, 1);
    assert.equal(agent.session.surface.replaceGeneration - generation, 1);
    const checkpoint = events.find(
      (e) =>
        e.type === "user/message" &&
        typeof e.surfaceOp === "object" &&
        e.surfaceOp.op === "replace",
    );
    assert.ok(checkpoint);
    assert.ok(JSON.stringify(agent.session.deriveMessages()).includes(SUMMARY));
    assert.ok(!JSON.stringify(agent.session.deriveMessages()).includes("OLD_TRANSACTION_HISTORY"));
    assert.equal(adapter.requests.length, scenario === "closing-marker" ? 1 : 2);
    if (scenario !== "closing-marker") {
      assert.ok(JSON.stringify(adapter.requests[1]!.messages).includes(SUMMARY));
      assert.ok(JSON.stringify(adapter.requests[1]!.messages).includes("AFTER_MAINTENANCE"));
      assert.ok(!JSON.stringify(adapter.requests[1]!.messages).includes("OLD_TRANSACTION_HISTORY"));
    }
    assert.equal(events.filter((e) => e.type === "tool/call").length, 0);
    assert.ok(
      events.filter((e) => e.type === "turn/end").every((e) => e.data.reason.kind === "completed"),
    );
    if (scenario.startsWith("flush-")) assert.equal(flushCalls, 1);
    await originalFlush.call(ctx.sessions, agent.session);
    return {
      scenario,
      sessionId,
      verified: true,
      errorCode,
      secondOwnerRefused,
      followupWaitedForFlush,
      retryRefused,
      flushCalls,
      realFlushBeforeError,
      checkpointReadBeforeError,
      checkpointPresentDespiteFailure: errorCode !== null,
      originalPrefixUnchanged: true,
      conversationCalls: adapter.requests.length,
      summaryCalls: adapter.summaryCalls,
      markerTypes: events.filter((e) => e.type.startsWith("compaction/")).map((e) => e.type),
      eventCount: events.length,
      eventFingerprint: fingerprintLog(events),
      surfaceNodes: [...agent.session.surface.nodes],
    };
  } finally {
    ctx.sessions.flush = originalFlush;
    agent.session.append = originalAppend;
    adapter.gate.release();
    checkpointGate.release();
    await operation?.catch(() => undefined);
    await handle.dispose();
    unregister();
  }
}
