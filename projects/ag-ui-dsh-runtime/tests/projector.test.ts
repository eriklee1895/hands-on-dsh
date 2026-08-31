import { EventSchemas, EventType, type BaseEvent } from "@ag-ui/core";
import { verifyEvents } from "@ag-ui/client";
import { from, lastValueFrom, toArray } from "rxjs";
import { describe, expect, test } from "vitest";
import { AguiProjector } from "../src/server/projector.ts";

const event = (type: string, data: unknown) => ({
  method: "session.event",
  params: {
    sessionId: "root",
    event: { type, seq: 0, time: 0, data },
  },
});

describe("per-step AG-UI projector", () => {
  test("projects text deltas, committed end and exact step lifecycle", () => {
    const projector = new AguiProjector("root");
    const output = [
      ...projector.accept(event("step/start", { turn: 1, step: 1 })),
      ...projector.accept(
        event("assistant/chunk", {
          turn: 1,
          step: 1,
          chunk: { type: "text-delta", index: 0, text: "hi" },
        }),
      ),
      ...projector.accept(
        event("assistant/message", {
          turn: 1,
          step: 1,
          message: { content: [{ type: "text", text: "hi" }] },
        }),
      ),
      ...projector.accept(event("step/end", { turn: 1, step: 1 })),
    ];
    expect(output.map((item) => item.type)).toEqual([
      EventType.STEP_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.STEP_FINISHED,
    ]);
    for (const item of output) expect(EventSchemas.parse(item)).toEqual(item);
  });

  test("synthesizes committed text without deltas and skips pure tool messages", () => {
    const projector = new AguiProjector("root");
    projector.accept(event("step/start", { turn: 2, step: 1 }));
    const text = projector.accept(
      event("assistant/message", {
        turn: 2,
        step: 1,
        message: { content: [{ type: "text", text: "committed" }] },
      }),
    );
    expect(text.map((item) => item.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);
    projector.accept(event("step/end", { turn: 2, step: 1 }));
    projector.accept(event("step/start", { turn: 2, step: 2 }));
    expect(
      projector.accept(
        event("assistant/message", {
          turn: 2,
          step: 2,
          message: { content: [{ type: "tool-call", id: "call", name: "tool", arguments: "{}" }] },
        }),
      ),
    ).toEqual([]);
  });

  test("projects tool call/result and rejects step end with open text", () => {
    const projector = new AguiProjector("root");
    projector.accept(event("step/start", { turn: 3, step: 1 }));
    projector.accept(
      event("assistant/message", {
        turn: 3,
        step: 1,
        message: {
          content: [{ type: "tool-call", id: "c1", name: "write", arguments: '{"x":1}' }],
        },
      }),
    );
    const tool = [
      ...projector.accept(
        event("tool/call", { turn: 3, step: 1, callId: "c1", name: "write", arguments: '{"x":1}' }),
      ),
      ...projector.accept(
        event("tool/result", {
          turn: 3,
          step: 1,
          message: {
            content: [
              {
                type: "tool-result",
                toolCallId: "c1",
                content: [{ type: "text", text: "ok" }],
                isError: false,
              },
            ],
          },
        }),
      ),
    ];
    expect(tool.map((item) => item.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
    ]);
    for (const item of tool) EventSchemas.parse(item);
    const broken = new AguiProjector("root");
    broken.accept(event("step/start", { turn: 4, step: 1 }));
    broken.accept(
      event("assistant/chunk", {
        turn: 4,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "partial" },
      }),
    );
    expect(() => broken.accept(event("step/end", { turn: 4, step: 1 }))).toThrow(/open text/);
  });

  test("ignores descendants and maps subagent lifecycle to CUSTOM", () => {
    const projector = new AguiProjector("root");
    expect(
      projector.accept({
        method: "session.event",
        params: { sessionId: "child", event: { type: "step/start", data: { turn: 1, step: 1 } } },
      }),
    ).toEqual([]);
    const custom = projector.accept({
      method: "subagent.started",
      params: { parentSessionId: "root", childSessionId: "child" },
    });
    expect(custom).toMatchObject([{ type: EventType.CUSTOM, name: "dsh.subagent.started" }]);
  });

  test("passes a complete multi-step tool transcript through AG-UI lifecycle verification", async () => {
    const projector = new AguiProjector("root");
    const projected = [
      ...projector.accept(event("step/start", { turn: 5, step: 1 })),
      ...projector.accept(
        event("assistant/message", {
          turn: 5,
          step: 1,
          message: { content: [{ type: "text", text: "first" }] },
        }),
      ),
      ...projector.accept(event("step/end", { turn: 5, step: 1 })),
      ...projector.accept(event("step/start", { turn: 5, step: 2 })),
      ...projector.accept(
        event("assistant/message", {
          turn: 5,
          step: 2,
          message: {
            content: [{ type: "tool-call", id: "call-5", name: "write", arguments: "{}" }],
          },
        }),
      ),
      ...projector.accept(
        event("tool/call", { turn: 5, step: 2, callId: "call-5", name: "write", arguments: "{}" }),
      ),
      ...projector.accept(
        event("tool/result", {
          turn: 5,
          step: 2,
          message: {
            content: [{ type: "tool-result", toolCallId: "call-5", content: [], isError: false }],
          },
        }),
      ),
      ...projector.accept(event("step/end", { turn: 5, step: 2 })),
    ];
    projector.assertClosed();
    const transcript: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "root", runId: "run-5" },
      ...projected,
      {
        type: EventType.RUN_FINISHED,
        threadId: "root",
        runId: "run-5",
        outcome: { type: "success" },
      },
    ];
    const verified = await lastValueFrom(from(transcript).pipe(verifyEvents(), toArray()));
    expect(verified).toEqual(transcript);
    expect(verified.at(-1)?.type).toBe(EventType.RUN_FINISHED);
  });

  test("rejects an empty or missing provider call id", () => {
    const projector = new AguiProjector("root");
    projector.accept(event("step/start", { turn: 6, step: 1 }));
    projector.accept(
      event("assistant/message", {
        turn: 6,
        step: 1,
        message: {
          content: [{ type: "tool-call", id: "expected", name: "write", arguments: "{}" }],
        },
      }),
    );
    expect(() =>
      projector.accept(
        event("tool/call", {
          turn: 6,
          step: 1,
          name: "write",
          arguments: "{}",
        }),
      ),
    ).toThrow(/call id/);
  });

  test("rejects a committed text message that differs from streamed deltas", () => {
    const projector = new AguiProjector("root");
    projector.accept(event("step/start", { turn: 7, step: 1 }));
    projector.accept(
      event("assistant/chunk", {
        turn: 7,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "streamed" },
      }),
    );
    expect(() =>
      projector.accept(
        event("assistant/message", {
          turn: 7,
          step: 1,
          message: { content: [{ type: "text", text: "different" }] },
        }),
      ),
    ).toThrow(/committed text/);
  });

  test("tracks multiple committed calls and requires every result before step end", () => {
    const projector = new AguiProjector("root");
    projector.accept(event("step/start", { turn: 8, step: 1 }));
    projector.accept(
      event("assistant/message", {
        turn: 8,
        step: 1,
        message: {
          content: [
            { type: "tool-call", id: "a", name: "one", arguments: "{}" },
            { type: "tool-call", id: "b", name: "two", arguments: "{}" },
          ],
        },
      }),
    );
    projector.accept(
      event("tool/call", { turn: 8, step: 1, callId: "a", name: "one", arguments: "{}" }),
    );
    projector.accept(
      event("tool/call", { turn: 8, step: 1, callId: "b", name: "two", arguments: "{}" }),
    );
    projector.accept(
      event("tool/result", {
        turn: 8,
        step: 1,
        message: {
          content: [{ type: "tool-result", toolCallId: "a", content: [], isError: false }],
        },
      }),
    );
    expect(() => projector.accept(event("step/end", { turn: 8, step: 1 }))).toThrow(/pending tool/);
    projector.accept(
      event("tool/result", {
        turn: 8,
        step: 1,
        message: {
          content: [{ type: "tool-result", toolCallId: "b", content: [], isError: true }],
        },
      }),
    );
    expect(projector.accept(event("step/end", { turn: 8, step: 1 }))).toMatchObject([
      { type: EventType.STEP_FINISHED },
    ]);
  });

  test("rejects calls before commit, orphan/duplicate results and non-boolean isError", () => {
    const beforeCommit = new AguiProjector("root");
    beforeCommit.accept(event("step/start", { turn: 9, step: 1 }));
    expect(() =>
      beforeCommit.accept(
        event("tool/call", {
          turn: 9,
          step: 1,
          callId: "a",
          name: "one",
          arguments: "{}",
        }),
      ),
    ).toThrow(/committed assistant/);

    const projector = new AguiProjector("root");
    projector.accept(event("step/start", { turn: 9, step: 2 }));
    projector.accept(
      event("assistant/message", {
        turn: 9,
        step: 2,
        message: { content: [{ type: "tool-call", id: "a", name: "one", arguments: "{}" }] },
      }),
    );
    projector.accept(
      event("tool/call", { turn: 9, step: 2, callId: "a", name: "one", arguments: "{}" }),
    );
    expect(() =>
      projector.accept(
        event("tool/call", {
          turn: 9,
          step: 2,
          callId: "a",
          name: "one",
          arguments: "{}",
        }),
      ),
    ).toThrow(/duplicate tool call/);
    expect(() =>
      projector.accept(
        event("tool/result", {
          turn: 9,
          step: 2,
          message: {
            content: [{ type: "tool-result", toolCallId: "orphan", content: [], isError: false }],
          },
        }),
      ),
    ).toThrow(/orphan tool result/);
    expect(() =>
      projector.accept(
        event("tool/result", {
          turn: 9,
          step: 2,
          message: { content: [{ type: "tool-result", toolCallId: "a", content: [] }] },
        }),
      ),
    ).toThrow(/isError/);
    projector.accept(
      event("tool/result", {
        turn: 9,
        step: 2,
        message: {
          content: [{ type: "tool-result", toolCallId: "a", content: [], isError: false }],
        },
      }),
    );
    expect(() =>
      projector.accept(
        event("tool/result", {
          turn: 9,
          step: 2,
          message: {
            content: [{ type: "tool-result", toolCallId: "a", content: [], isError: false }],
          },
        }),
      ),
    ).toThrow(/duplicate tool result/);
  });

  test("requires durable tool call fields and set to equal the committed assistant calls", () => {
    const mismatch = new AguiProjector("root");
    mismatch.accept(event("step/start", { turn: 10, step: 1 }));
    mismatch.accept(
      event("assistant/message", {
        turn: 10,
        step: 1,
        message: {
          content: [{ type: "tool-call", id: "a", name: "one", arguments: '{"x":1}' }],
        },
      }),
    );
    expect(() =>
      mismatch.accept(
        event("tool/call", {
          turn: 10,
          step: 1,
          callId: "a",
          name: "other",
          arguments: '{"x":1}',
        }),
      ),
    ).toThrow(/differs from committed/);

    const missing = new AguiProjector("root");
    missing.accept(event("step/start", { turn: 10, step: 2 }));
    missing.accept(
      event("assistant/message", {
        turn: 10,
        step: 2,
        message: {
          content: [{ type: "tool-call", id: "missing", name: "one", arguments: "{}" }],
        },
      }),
    );
    expect(() => missing.accept(event("step/end", { turn: 10, step: 2 }))).toThrow(
      /without every committed tool call/,
    );
  });
});
