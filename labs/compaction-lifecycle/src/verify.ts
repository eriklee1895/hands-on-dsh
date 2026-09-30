/** Verify durable compaction facts with the release's own surface fold. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Context } from "@deepseek-ai/cordis";
import { isCompactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import {
  deriveEventMessage,
  foldSurface,
  SessionId,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import JsonlPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";

export function surfaceText(events: readonly SessionEvent[]): string {
  const surface = foldSurface(events);
  return surface.nodes
    .map((seq) => {
      const message = deriveEventMessage(events[seq]!, surface.projectedMessages);
      return JSON.stringify(message?.content ?? []);
    })
    .join("\n");
}

/** Require one complete summary transaction and the original seed's removal from current surface. */
export function inspectCompaction(
  events: readonly SessionEvent[],
  seedSeq: number,
  code: string,
  noiseMarker: string,
) {
  const summaries = events.filter((event) => event.type === "compaction/summary");
  assert.equal(summaries.length, 1, "exactly one summarization transaction");
  const summary = summaries[0]!;
  const id = summary.data.compactionId;
  const start = events.find(
    (event) => event.type === "compaction/start" && event.data.compactionId === id,
  );
  const end = events.find(
    (event) => event.type === "compaction/end" && event.data.compactionId === id,
  );
  assert.ok(start?.type === "compaction/start");
  assert.ok(end?.type === "compaction/end");
  assert.ok(start.seq < summary.seq && summary.seq < end.seq);
  assert.equal(end.data.error, undefined, "compaction must close without error");
  assert.ok(
    summary.data.shadowedSeqs.some((seq) => seq === seedSeq),
    "old fact must really be shadowed",
  );
  assert.ok(summary.data.llmStreamCall === true, "a real LLM-seam summary call");
  assert.equal(summary.data.provider, "deepseek-official");
  assert.equal(summary.data.model, "deepseek-flash");
  assert.ok(summary.data.usage && summary.data.usage.inputTokens > 0, "summary usage reported");
  const text = summary.data.summary
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.ok(text.includes(code), "summary preserves exact recovery code");
  const replacement = events[summary.seq + 1];
  assert.ok(replacement?.type === "user/message");
  assert.ok(isCompactCheckpointSource(replacement.data.source));
  assert.equal(replacement.data.source.compactionId, id);
  assert.deepEqual(replacement.surfaceOp, {
    op: "replace",
    startSeq: summary.data.shadowedRange.start,
    endSeq: summary.data.shadowedRange.end,
  });
  for (const seq of [start.seq, summary.seq, ...summary.data.shadowedSeqs])
    assert.ok(replacement.sourceEventSeqs?.includes(seq));
  const checkpointText = replacement.data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  assert.ok(checkpointText.includes(text), "checkpoint contains the actual summary text");
  assert.ok(checkpointText.includes(code), "checkpoint retains exact code");
  const surface = foldSurface(events);
  assert.ok(!surface.nodes.some((seq) => seq === seedSeq));
  assert.ok(surface.nodes.includes(replacement.seq));
  assert.ok(
    !surfaceText(events).includes(noiseMarker),
    "old disposable content is absent from surface",
  );
  assert.ok(
    JSON.stringify(events[seedSeq]).includes(noiseMarker),
    "original log record remains intact",
  );
  return {
    compactionId: id,
    startSeq: start.seq,
    summarySeq: summary.seq,
    checkpointSeq: replacement.seq,
    endSeq: end.seq,
    turn: start.data.turn,
    shadowedSeqs: summary.data.shadowedSeqs,
    shadowedTokenCount: summary.data.shadowedTokenCount,
    summaryUsage: summary.data.usage,
    summarySha256: createHash("sha256").update(text).digest("hex"),
    originalSeedInLog: true,
    originalSeedOnSurface: false,
    codeInSummary: true,
    surfaceNodes: surface.nodes,
  };
}

/** Reopen only through the public backend, after the live SDK owner has exited. */
export async function readPersisted(root: string, sessionId: string) {
  const context = new Context();
  try {
    await context.plugin(JsonlPersistence, { root, compression: "none" });
    const reader = await context.sessionPersistence.open(SessionId(sessionId), "read");
    try {
      return { header: reader.header, events: (await reader.read()).events };
    } finally {
      await reader.close();
    }
  } finally {
    await context.fiber.dispose();
  }
}

/** Establish the retained code existed in the checkpoint before the proof-producing model step. */
export function inspectBeforeProof(
  events: readonly SessionEvent[],
  callSeq: number,
  seedSeq: number,
  code: string,
  noiseMarker: string,
) {
  const call = events[callSeq];
  assert.ok(call?.type === "tool/call");
  const step = events.find(
    (event) =>
      event.type === "step/start" &&
      event.data.turn === call.data.turn &&
      event.data.step === call.data.step,
  );
  assert.ok(step && step.seq < call.seq, "proof call has an earlier step start");
  const prefix = events.slice(0, step.seq);
  const evidence = inspectCompaction(prefix, seedSeq, code, noiseMarker);
  const surface = foldSurface(prefix);
  for (const seq of surface.nodes) {
    if (seq === evidence.checkpointSeq) continue;
    assert.ok(
      !JSON.stringify(deriveEventMessage(prefix[seq]!, surface.projectedMessages)).includes(code),
      "retained non-checkpoint message must not supply the code",
    );
  }
  return {
    compactionBeforeProofStep: true,
    proofStepSeq: step.seq,
    proofCallSeq: call.seq,
    checkpointOnlyCodeSource: true,
  };
}
