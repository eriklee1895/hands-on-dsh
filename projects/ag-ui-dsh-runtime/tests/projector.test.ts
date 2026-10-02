import { EventSchemas, EventType } from "@ag-ui/core";
import { expect, test } from "vitest";
import { AguiProjector } from "../src/server/projector.ts";

const notice = (sessionId: string, type: string, data: unknown) => ({
  method: "session.event",
  params: { sessionId, event: { type, seq: 0, time: 0, data } },
});

test("projects only root committed text as one complete AG-UI message", () => {
  const projector = new AguiProjector("root");
  expect(projector.accept(notice("root", "step/start", { turn: 1, step: 1 }))).toMatchObject([
    { type: EventType.STEP_STARTED },
  ]);
  expect(
    projector.accept(
      notice("root", "assistant/chunk", {
        turn: 1,
        step: 1,
        chunk: { type: "text-delta", text: "not durable" },
      }),
    ),
  ).toEqual([]);
  expect(
    projector.accept(
      notice("child", "assistant/message", {
        turn: 1,
        step: 1,
        message: { content: [{ type: "text", text: "child" }] },
      }),
    ),
  ).toEqual([]);
  const message = projector.accept(
    notice("root", "assistant/message", {
      turn: 1,
      step: 1,
      message: {
        content: [
          { type: "text", text: "one" },
          { type: "text", text: " two" },
        ],
      },
    }),
  );
  expect(message.map((event) => event.type)).toEqual([
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
  ]);
  expect(message[1]).toMatchObject({ delta: "one two" });
  for (const event of message) EventSchemas.parse(event);
  expect(projector.accept(notice("root", "step/end", { turn: 1, step: 1 }))).toMatchObject([
    { type: EventType.STEP_FINISHED },
  ]);
  projector.assertClosed();
});

test("uses V4 tool-result message fields while preserving call matching", () => {
  const projector = new AguiProjector("root");
  projector.accept(notice("root", "step/start", { turn: 2, step: 1 }));
  projector.accept(
    notice("root", "assistant/message", {
      turn: 2,
      step: 1,
      message: {
        content: [{ type: "tool-call", id: "call-2", name: "write_stage4_proof", arguments: "{}" }],
      },
    }),
  );
  projector.accept(
    notice("root", "tool/call", {
      turn: 2,
      step: 1,
      callId: "call-2",
      name: "write_stage4_proof",
      arguments: "{}",
    }),
  );
  const result = projector.accept(
    notice("root", "tool/result", {
      turn: 2,
      step: 1,
      message: {
        role: "tool",
        toolCallId: "call-2",
        isError: false,
        content: [{ type: "text", text: '{"path":"stage4-proof.txt"}' }],
      },
    }),
  );
  expect(result).toMatchObject([{ type: EventType.TOOL_CALL_RESULT, toolCallId: "call-2" }]);
  expect(JSON.parse((result[0] as { content: string }).content)).toMatchObject({
    isError: false,
    content: [{ type: "text", text: '{"path":"stage4-proof.txt"}' }],
  });
  expect(projector.accept(notice("root", "step/end", { turn: 2, step: 1 }))).toMatchObject([
    { type: EventType.STEP_FINISHED },
  ]);
});

test("rejects unmatched, duplicate, and unfinished V4 tool calls", () => {
  const projector = new AguiProjector("root");
  projector.accept(notice("root", "step/start", { turn: 3, step: 1 }));
  expect(() =>
    projector.accept(
      notice("root", "tool/call", {
        turn: 3,
        step: 1,
        callId: "early",
        name: "write_stage4_proof",
        arguments: "{}",
      }),
    ),
  ).toThrow(/committed assistant/);
  projector.accept(
    notice("root", "assistant/message", {
      turn: 3,
      step: 1,
      message: {
        content: [
          { type: "tool-call", id: "a", name: "write_stage4_proof", arguments: "{}" },
          { type: "tool-call", id: "b", name: "write_stage4_proof", arguments: "{}" },
        ],
      },
    }),
  );
  expect(() =>
    projector.accept(
      notice("root", "tool/call", {
        turn: 3,
        step: 1,
        callId: "a",
        name: "other",
        arguments: "{}",
      }),
    ),
  ).toThrow(/differs from committed/);
  for (const callId of ["a", "b"]) {
    projector.accept(
      notice("root", "tool/call", {
        turn: 3,
        step: 1,
        callId,
        name: "write_stage4_proof",
        arguments: "{}",
      }),
    );
  }
  expect(() =>
    projector.accept(
      notice("root", "tool/result", {
        turn: 3,
        step: 1,
        message: { role: "tool", toolCallId: "orphan", content: [], isError: false },
      }),
    ),
  ).toThrow(/orphan tool result/);
  projector.accept(
    notice("root", "tool/result", {
      turn: 3,
      step: 1,
      message: { role: "tool", toolCallId: "a", content: [], isError: false },
    }),
  );
  expect(() => projector.accept(notice("root", "step/end", { turn: 3, step: 1 }))).toThrow(
    /pending tool/,
  );
  projector.accept(
    notice("root", "tool/result", {
      turn: 3,
      step: 1,
      message: { role: "tool", toolCallId: "b", content: [], isError: true },
    }),
  );
  expect(() =>
    projector.accept(
      notice("root", "tool/result", {
        turn: 3,
        step: 1,
        message: { role: "tool", toolCallId: "b", content: [], isError: true },
      }),
    ),
  ).toThrow(/duplicate tool result/);
  expect(projector.accept(notice("root", "step/end", { turn: 3, step: 1 }))).toMatchObject([
    { type: EventType.STEP_FINISHED },
  ]);
});

test("requires a committed assistant message before closing each step", () => {
  const projector = new AguiProjector("root");
  projector.accept(notice("root", "step/start", { turn: 4, step: 1 }));
  expect(() => projector.accept(notice("root", "step/end", { turn: 4, step: 1 }))).toThrow(
    /committed assistant/,
  );
  projector.accept(
    notice("root", "assistant/message", {
      turn: 4,
      step: 1,
      message: { content: [{ type: "text", text: "complete" }] },
    }),
  );
  expect(() =>
    projector.accept(
      notice("root", "assistant/message", {
        turn: 4,
        step: 1,
        message: { content: [{ type: "text", text: "duplicate" }] },
      }),
    ),
  ).toThrow(/duplicate committed/);
  projector.accept(notice("root", "step/end", { turn: 4, step: 1 }));
  projector.assertClosed();
});
