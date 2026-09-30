/** Controlled tool/image inputs through the released compaction companions. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import { AttachmentId } from "@deepseek-ai/dsh-attachment";
import {
  LlmAdapter,
  LlmError,
  IMAGE_OFFLOAD_REQUIRED_CODE,
  ToolCallId,
  createUserMessage,
  projectOffloadedImages,
  offloadedImageText,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type RequestMessage,
} from "@deepseek-ai/dsh-llm";
import {
  SessionId,
  foldSurface,
  deriveEventMessage,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { defineContentToolFixture } from "@deepseek-ai/dsh-tools";
import { PRUNE_MARKER } from "@deepseek-ai/dsh-compaction-tool-result-pruner";
import { imageOffloadProjection } from "@deepseek-ai/dsh-compaction-image-offload/projection";
import { fingerprintJson, fingerprintLog } from "./replay-evidence.ts";

export const REDUCTION_SCENARIOS = [
  "prune-below-pressure",
  "prune-relieves-pressure",
  "prune-summary-fails",
  "prune-summary-cancel",
  "image-agent-recover",
  "image-exhausted",
  "image-no-count",
  "image-summary-fails",
  "image-summary-cancel",
  "prune-preserves-offload",
] as const;
export type ReductionScenario = (typeof REDUCTION_SCENARIOS)[number];
export function reductionConfig(scenario: ReductionScenario) {
  return {
    auto: true,
    thresholdRatio: [
      "prune-relieves-pressure",
      "prune-summary-fails",
      "prune-summary-cancel",
    ].includes(scenario)
      ? 0.002
      : 1,
    headroomTokens: 0,
    retainTokens: 0,
    maxTokens: 64,
    compactionRetries: 0,
    maxOverflowRetries: 1,
  };
}
const LEFT = "😀HEAD:" + "MIDDLE_DISPOSABLE_".repeat(1000),
  RIGHT = "MIDDLE_DISPOSABLE_".repeat(1000) + ":TAIL🚀";
const FULL = LEFT + RIGHT;
const TRIMMED =
  Array.from(FULL).slice(0, 24).join("") + PRUNE_MARKER + Array.from(FULL).slice(-24).join("");
const LONG = "KEEP_THIS_USER_CONTEXT ".repeat(900);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQWRDwHwAD1AIEvJeHVwAAAABJRU5ErkJggg==",
  "base64",
);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PROVIDER = "lesson-reduction";
const text = (messages: readonly { content: readonly ContentBlock[] }[]) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => b.text)).join("");
const images = (messages: readonly { content: readonly ContentBlock[] }[]) =>
  messages.flatMap((m) => m.content.filter((b) => b.type === "image"));
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class ReductionAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];
  readonly summaries: GenerateOptions[] = [];
  readonly summaryViews: (readonly RequestMessage[])[] = [];
  readonly views: (readonly RequestMessage[])[] = [];
  readonly entered = deferred();
  readonly gate = deferred();
  beforeImageFailure = () => {};
  imageFailed = false;
  constructor(
    readonly scenario: ReductionScenario,
    readonly imagePath: string,
  ) {
    super();
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: model === "larger" ? 2_000_000 : 1_000_000 },
    };
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const view = projectOffloadedImages(options.messages, (ref) =>
      offloadedImageText(ref, { readonlyPath: this.imagePath }),
    );
    if (options.purpose === "compaction") {
      this.summaries.push(options);
      this.summaryViews.push(view);
      this.entered.release();
      if (this.scenario === "prune-summary-cancel") {
        await this.gate.promise;
        options.signal?.throwIfAborted();
      }
      if (this.scenario.startsWith("image-summary-") && this.summaries.length === 1) {
        this.beforeImageFailure();
        throw new LlmError("controlled image budget", IMAGE_OFFLOAD_REQUIRED_CODE, {
          offloadImages: 1,
        });
      }
      throw new Error("controlled summary failure");
    }
    this.requests.push(options);
    this.views.push(view);
    if (this.scenario.startsWith("prune-") && this.requests.length === 1) {
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield {
        type: "block-end",
        index: 0,
        block: {
          type: "tool-call",
          id: ToolCallId("fixture-call"),
          name: "fixture_output",
          arguments: "{}",
        },
      };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    const fail =
      this.scenario === "image-exhausted" ||
      this.scenario === "image-no-count" ||
      (!this.imageFailed &&
        (this.scenario === "image-agent-recover" || this.scenario === "prune-preserves-offload"));
    if (fail) {
      this.imageFailed = true;
      this.beforeImageFailure();
      throw new LlmError(
        "controlled image budget",
        IMAGE_OFFLOAD_REQUIRED_CODE,
        this.scenario === "image-no-count" ? undefined : { offloadImages: 1 },
      );
    }
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "block-end", index: 0, block: { type: "text", text: "READY" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}
/** Reconstruct message contents with the same explicit image projection as the live Session. */
export function reductionMessages(events: readonly SessionEvent[]) {
  const surface = foldSurface(events, [imageOffloadProjection]);
  return surface.nodes.flatMap((seq) => {
    const value = deriveEventMessage(events[seq]!, surface.projectedMessages);
    return value === null ? [] : [value];
  });
}
/** Execute one deterministic scenario and verify log, model inputs and independent image bytes. */
export async function runReduction(
  ctx: Context,
  scenario: ReductionScenario,
  sessionId: string,
  imagePath: string,
) {
  await writeFile(imagePath, PNG, { flag: "wx", mode: 0o444 });
  const image = (name: string): Extract<ContentBlock, { type: "image" }> => ({
    type: "image",
    attachment: {
      attachmentId: AttachmentId("sha256:" + digest(PNG)),
      mediaType: "image/png",
      bytes: PNG.length,
      width: 1,
      height: 1,
      name,
    },
  });
  const adapter = new ReductionAdapter(scenario, imagePath);
  const unregister = ctx.llm.registerAdapter([PROVIDER], adapter);
  let toolExecutions = 0;
  const removeTool = ctx.tools.register(
    defineContentToolFixture({
      name: "fixture_output",
      description: "Emit predetermined text and optional image metadata",
      parameters: {},
      async execute() {
        toolExecutions++;
        return scenario === "prune-preserves-offload"
          ? [{ type: "text", text: LEFT }, image("tool.png"), { type: "text", text: RIGHT }]
          : [{ type: "text", text: FULL }];
      },
    }),
  );
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId),
    agentOptions: { provider: PROVIDER, model: "fixture", maxTokens: 64 },
  });
  const agent = handle.agent;
  let prefix: SessionEvent[] | undefined;
  let beforeNodes: readonly number[] = [];
  const offloadNodes: { before: readonly number[]; after: readonly number[] }[] = [];
  const controller = new AbortController();
  const cancelReason = new Error("cancel after durable offload");
  const offEvents = ctx.on("session/event", (session, event) => {
    if (session !== agent.session) return;
    if (event.type === "tool/result" && event.surfaceOp === "append" && prefix === undefined)
      prefix = structuredClone([...session.snapshotEvents()]);
    if (event.type === "image/offload") {
      offloadNodes.push({ before: beforeNodes, after: [...session.surface.nodes] });
      if (scenario === "image-summary-cancel") controller.abort(cancelReason);
    }
  });
  adapter.beforeImageFailure = () => {
    prefix ??= structuredClone([...agent.session.snapshotEvents()]);
    beforeNodes = [...agent.session.surface.nodes];
  };
  let offRoute: (() => void) | undefined;
  let offPrune: (() => void) | undefined;
  let manualOutcome: string | undefined;
  try {
    const usesImages = scenario.startsWith("image-");
    const longInput =
      scenario === "prune-summary-fails" ||
      scenario === "prune-summary-cancel" ||
      scenario.startsWith("image-summary-");
    agent.followup(
      createUserMessage({
        content: [
          { type: "text", text: longInput ? LONG : "RUN_FIXTURE" },
          ...(usesImages ? [image("first.png"), image("second.png")] : []),
        ],
        source: { kind: "user" },
      }),
    );
    if (scenario === "prune-summary-cancel") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          adapter.entered.promise,
          new Promise<never>((_r, reject) => {
            timer = setTimeout(() => reject(new Error("summary gate timeout")), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      agent.cancel({ kind: "user" });
      adapter.gate.release();
    }
    await agent.whenIdle();
    if (scenario.startsWith("image-summary-")) {
      let rejected: unknown;
      try {
        await ctx.compaction.compactNow(agent, controller.signal);
      } catch (error) {
        rejected = error;
      }
      if (scenario === "image-summary-cancel") assert.equal(rejected, cancelReason);
      else
        assert.ok(rejected instanceof Error && "code" in rejected && rejected.code === "summary");
      manualOutcome = scenario === "image-summary-cancel" ? "cancelled" : "summary-error";
    }
    if (scenario === "image-agent-recover") {
      offRoute = ctx.on("agent/request", async (_scope, next) => ({
        ...(await next()),
        model: "larger",
      }));
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "NEW_OCCURRENCE" }, image("new.png")],
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
      assert.equal(adapter.requests.at(-1)!.model, "larger");
      assert.deepEqual(
        images(adapter.requests.at(-1)!.messages).map((b) => [
          b.attachment.name,
          b.offloaded === true,
        ]),
        [
          ["first.png", true],
          ["second.png", false],
          ["new.png", false],
        ],
      );
    }
    if (scenario === "prune-preserves-offload") {
      let pruned = false;
      offPrune = ctx.on("agent/pre-step", async (scope, next) => {
        if (scope.agent === agent && !pruned) {
          assert.equal(ctx.toolResultPruner.pruneSession(agent.session).pruned.length, 1);
          pruned = true;
        }
        return next();
      });
      agent.followup(
        createUserMessage({
          content: [{ type: "text", text: "AFTER_PRUNE" }],
          source: { kind: "user" },
        }),
      );
      await agent.whenIdle();
      assert.ok(pruned);
      assert.equal(images(adapter.requests.at(-1)!.messages)[0]?.offloaded, true);
    }
    const expectedRequests: Record<ReductionScenario, number> = {
      "prune-below-pressure": 2,
      "prune-relieves-pressure": 2,
      "prune-summary-fails": 2,
      "prune-summary-cancel": 1,
      "image-agent-recover": 3,
      "image-exhausted": 3,
      "image-no-count": 1,
      "image-summary-fails": 1,
      "image-summary-cancel": 1,
      "prune-preserves-offload": 4,
    };
    assert.equal(adapter.requests.length, expectedRequests[scenario]);
    assert.equal(
      toolExecutions,
      scenario.startsWith("prune-") ? 1 : 0,
      "pruning never re-executes the tool",
    );
    const events = [...agent.session.snapshotEvents()];
    assert.equal(events.filter((e) => e.type === "tool/call").length, toolExecutions);
    assert.equal(
      events.filter((e) => e.type === "turn/end").length,
      ["image-agent-recover", "prune-preserves-offload"].includes(scenario) ? 2 : 1,
    );
    if (prefix) assert.deepEqual(events.slice(0, prefix.length), prefix);
    const prunes = events.filter((e) => e.type === "compaction/prune");
    const offloads = events.filter((e) => e.type === "image/offload");
    const expectPrune = scenario.startsWith("prune-") && scenario !== "prune-below-pressure";
    assert.equal(prunes.length, expectPrune ? 1 : 0);
    assert.equal(agent.session.surface.replaceGeneration, expectPrune ? 1 : 0);
    assert.equal(events.filter((e) => e.type === "compaction/summary").length, 0);
    assert.equal(events.filter((e: { type: string }) => e.type === "llm/retry").length, 0);
    const expectedSummaries = scenario.startsWith("image-summary-")
      ? scenario === "image-summary-fails"
        ? 2
        : 1
      : scenario.startsWith("prune-summary-")
        ? 1
        : 0;
    assert.equal(adapter.summaries.length, expectedSummaries);
    const brackets = events.filter((e) => e.type === "compaction/start");
    const closes = events.filter((e) => e.type === "compaction/end");
    assert.equal(brackets.length, expectedSummaries > 0 ? 1 : 0);
    assert.equal(closes.length, brackets.length);
    if (brackets.length) {
      assert.equal(brackets[0]!.data.compactionId, closes[0]!.data.compactionId);
      assert.equal(typeof closes[0]!.data.error, "string");
    }
    const end = events.filter((e) => e.type === "turn/end").at(-1)!;
    const expectedEnd =
      scenario === "prune-summary-cancel"
        ? "aborted"
        : ["image-exhausted", "image-no-count"].includes(scenario)
          ? "error"
          : "completed";
    assert.equal(end.data.reason.kind, expectedEnd);
    if (end.data.reason.kind === "aborted") assert.equal(end.data.reason.reason.kind, "user");
    if (end.data.reason.kind === "error")
      assert.equal(end.data.reason.error.code, IMAGE_OFFLOAD_REQUIRED_CODE);
    if (scenario.startsWith("prune-")) {
      const original = events.find((e) => e.type === "tool/result" && e.surfaceOp === "append");
      assert.ok(original?.type === "tool/result");
      assert.equal(text([original.data.message]), FULL);
      const current = agent.session.deriveMessages().find((m) => m.role === "tool");
      assert.ok(current);
      assert.equal(text([current]), expectPrune ? TRIMMED : FULL);
      if (scenario === "prune-preserves-offload") {
        assert.deepEqual(original.data.message.content, [
          { type: "text", text: LEFT },
          image("tool.png"),
          { type: "text", text: RIGHT },
        ]);
        const expectedContent: ContentBlock[] = [
          { type: "text", text: Array.from(FULL).slice(0, 24).join("") + PRUNE_MARKER },
          { ...image("tool.png"), offloaded: true },
          { type: "text", text: Array.from(FULL).slice(-24).join("") },
        ];
        assert.deepEqual(
          current.content,
          expectedContent,
          "all rich-block fields and positions survive pruning",
        );
        const actualView = adapter.views.at(-1)!.find((m) => m.role === "tool");
        assert.ok(actualView);
        assert.deepEqual(actualView.content, [
          expectedContent[0],
          {
            type: "text",
            text: offloadedImageText(image("tool.png").attachment, { readonlyPath: imagePath }),
          },
          expectedContent[2],
        ]);
      }
      if (expectPrune) {
        const replacement = events[prunes[0]!.seq + 1];
        assert.ok(replacement?.type === "tool/result");
        assert.deepEqual(prunes[0]!.data.shadowedSeqs, [original.seq]);
        assert.deepEqual(replacement.sourceEventSeqs, [original.seq]);
        assert.deepEqual(replacement.surfaceOp, {
          op: "replace",
          startSeq: original.seq,
          endSeq: original.seq,
        });
        const strip = (event: typeof original) => ({
          ...event.data,
          message: { ...event.data.message, content: [] },
        });
        assert.deepEqual(strip(replacement), strip(original));
        assert.ok(ctx.toolResultPruner.measureContent(current.content) <= 256);
        const before = events.length;
        assert.equal(ctx.toolResultPruner.pruneSession(agent.session).pruned.length, 0);
        assert.equal(agent.session.snapshotEvents().length, before);
        if (adapter.requests.length > 1)
          assert.ok(!text(adapter.requests.at(-1)!.messages).includes(FULL));
      }
    }
    const expectedOffloads =
      scenario === "image-exhausted"
        ? 2
        : scenario === "image-no-count" || (!usesImages && scenario !== "prune-preserves-offload")
          ? 0
          : 1;
    assert.equal(offloads.length, expectedOffloads);
    for (const pair of offloadNodes)
      assert.deepEqual(pair.before, pair.after, "offload must not change surface node identities");
    for (const event of offloads) {
      const original = events[event.data.targets[0]!.seq];
      assert.ok(original?.type === "user/message" || original?.type === "tool/result");
      const content =
        original.type === "user/message" ? original.data.content : original.data.message.content;
      assert.ok(content.filter((b) => b.type === "image").every((b) => b.offloaded !== true));
    }
    if (expectedOffloads) {
      const viewed = projectOffloadedImages(agent.session.deriveMessages(), (ref) =>
        offloadedImageText(ref, { readonlyPath: imagePath }),
      );
      assert.ok(text(viewed).includes(imagePath));
      assert.ok(text(viewed).includes("sha256:"));
      assert.equal(offloads[0]!.data.targets[0]!.imageIndexes[0], 0);
      if (scenario === "image-exhausted")
        assert.deepEqual(
          offloads.map((e) => e.data.targets[0]!.imageIndexes),
          [[0], [1]],
        );
    }
    if (scenario === "image-agent-recover") {
      assert.deepEqual(
        adapter.views.map((view) => images(view).length),
        [2, 1, 2],
      );
      assert.ok(
        adapter.views[1]!.some((m) =>
          m.content.some(
            (b) =>
              b.type === "text" &&
              b.text ===
                offloadedImageText(image("first.png").attachment, { readonlyPath: imagePath }),
          ),
        ),
      );
    }
    if (scenario === "image-exhausted")
      assert.deepEqual(
        adapter.views.map((view) => images(view).length),
        [2, 1, 0],
      );
    if (scenario === "image-summary-fails")
      assert.deepEqual(
        adapter.summaryViews.map((view) => images(view).length),
        [2, 1],
      );
    if (adapter.requests.length > 1 && usesImages)
      assert.ok(images(adapter.requests[0]!.messages).every((b) => b.offloaded !== true));
    assert.deepEqual(
      await readFile(imagePath),
      PNG,
      "offload does not delete or rewrite the image file",
    );
    assert.deepEqual(reductionMessages(events), agent.session.deriveMessages());
    return {
      scenario,
      verified: true,
      sessionId,
      terminal: end.data.reason,
      manualOutcome,
      conversationCalls: adapter.requests.length,
      toolExecutions,
      summaryCalls: adapter.summaries.length,
      pruneCount: prunes.length,
      offloadCount: offloads.length,
      replacementGeneration: agent.session.surface.replaceGeneration,
      rawPrefixUnchanged: true,
      imageFileUnchanged: true,
      imageBytes: PNG.length,
      imageSha256: digest(PNG),
      eventCount: events.length,
      eventFingerprint: fingerprintLog(events),
      surfaceNodes: [...agent.session.surface.nodes],
      projectedFingerprint: fingerprintJson(agent.session.deriveMessages()),
      markerTypes: events
        .filter((e) => e.type.startsWith("compaction/") || e.type === "image/offload")
        .map((e) => e.type),
    };
  } finally {
    adapter.gate.release();
    offRoute?.();
    offPrune?.();
    offEvents();
    await handle.dispose();
    removeTool();
    unregister();
  }
}
