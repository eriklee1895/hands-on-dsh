import { ToolCallId } from "@deepseek-ai/dsh-llm/brand";
import { expect, it } from "vitest";
import { createUserMessage, createAssistantMessage } from "@deepseek-ai/dsh-llm";
import { CompactionId, compactCheckpointSource } from "@deepseek-ai/dsh-compaction";
import { Session, SessionId, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { inspectCompaction, inspectBeforeProof } from "../src/verify.ts";

function recordedFixture(loseCode = false): SessionEvent[] {
  const session = Session.create(SessionId("verification-fixture"));
  const events: SessionEvent[] = [];
  const seed = session.append(
    "user/message",
    createUserMessage({
      source: { kind: "user" },
      content: [{ type: "text", text: "CODE and DISCARD_MARKER" }],
    }),
    { surfaceOp: "append" },
  );
  events.push(seed);
  events.push(
    session.append(
      "assistant/message",
      {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          source: { provider: "deepseek-official", model: "deepseek-flash" },
          content: [{ type: "text", text: "READY" }],
        }),
        stream: [],
      },
      { surfaceOp: "append" },
    ),
  );
  const id = CompactionId("fixture-compaction");
  const start = session.append("compaction/start", { compactionId: id, turn: null });
  events.push(start);
  const summary = session.append("compaction/summary", {
    compactionId: id,
    summary: [{ type: "text", text: "Saved CODE" }],
    shadowedRange: { start: seed.seq, end: seed.seq },
    shadowedSeqs: [seed.seq],
    shadowedTokenCount: 100,
    provider: "deepseek-official",
    model: "deepseek-flash",
    usage: { inputTokens: 10, outputTokens: 2 },
    llmStreamCall: true,
    rawOutput: [],
  });
  events.push(summary);
  events.push(
    session.append(
      "user/message",
      createUserMessage({
        source: compactCheckpointSource(id),
        content: loseCode ? [{ type: "text", text: "CHECKPOINT LOST FACT" }] : summary.data.summary,
      }),
      {
        surfaceOp: { op: "replace", startSeq: seed.seq, endSeq: seed.seq },
        sourceEventSeqs: [seed.seq, start.seq, summary.seq],
      },
    ),
  );
  events.push(session.append("compaction/end", { compactionId: id, turn: null }));
  return events;
}
it("requires a complete correlated replacement and preserved code", () => {
  const events = recordedFixture();
  expect(inspectCompaction(events, 0, "CODE", "DISCARD_MARKER")).toMatchObject({
    originalSeedInLog: true,
    originalSeedOnSurface: false,
  });
  expect(() => inspectCompaction(events.slice(0, -1), 0, "CODE", "DISCARD_MARKER")).toThrow();
  expect(() => inspectCompaction(events, 1, "CODE", "DISCARD_MARKER")).toThrow();
  expect(() => inspectCompaction(events, 0, "ABSENT_CODE", "DISCARD_MARKER")).toThrow();
});

it("rejects a checkpoint that loses the fact even when the summary preserves it", () => {
  expect(() => inspectCompaction(recordedFixture(true), 0, "CODE", "DISCARD_MARKER")).toThrow();
});

it("rejects compaction after the proof step and code leaked into a retained message", () => {
  const events = recordedFixture();
  const step: SessionEvent<"step/start"> = {
    type: "step/start",
    seq: SessionSeq(6),
    time: 20,
    data: { turn: 2, step: 1 },
  };
  const call: SessionEvent<"tool/call"> = {
    type: "tool/call",
    seq: SessionSeq(7),
    time: 21,
    data: { turn: 2, step: 1, name: "bash", arguments: "{}", callId: ToolCallId("proof") },
  };
  const withProof = [...events, step, call];
  expect(inspectBeforeProof(withProof, 7, 0, "CODE", "DISCARD_MARKER")).toMatchObject({
    compactionBeforeProofStep: true,
  });
  const late = structuredClone(withProof);
  late[2] = { ...step, seq: SessionSeq(2) };
  expect(() => inspectBeforeProof(late, 7, 0, "CODE", "DISCARD_MARKER")).toThrow();
  const leaked = structuredClone(withProof);
  const message = leaked[1];
  if (message?.type === "assistant/message")
    leaked[1] = {
      ...message,
      data: {
        ...message.data,
        message: {
          ...message.data.message,
          content: [{ type: "text" as const, text: "READY CODE" }],
        },
      },
    };
  expect(() => inspectBeforeProof(leaked, 7, 0, "CODE", "DISCARD_MARKER")).toThrow();
});
