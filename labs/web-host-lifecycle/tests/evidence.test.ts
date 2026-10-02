import { expect, it } from "vitest";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createToolResultMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { publicUrl, verifyTurns } from "../src/evidence.ts";
function events(error = false, description = false) {
  const session = Session.create(SessionId("fixture"));
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 1 });
  const callId = ToolCallId("call");
  session.append("tool/call", {
    turn: 1,
    step: 1,
    callId,
    name: "bash",
    arguments: JSON.stringify({
      command: "cat proof.txt",
      ...(description ? { description: "Read proof" } : {}),
    }),
  });
  session.append(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: "text", text: "proof" }],
        isError: error,
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  return session.snapshotEvents();
}
it("prints only a clean loopback URL and rejects non-loopback launch output", () => {
  expect(publicUrl("http://127.0.0.1:19387/?token=private-token")).toBe("http://127.0.0.1:19387/");
  expect(() => publicUrl("https://example.com/?token=private-token")).toThrow();
});
it("requires exact successful Bash evidence plus completed turns", () => {
  expect(() => verifyTurns(events(), ["cat proof.txt"])).not.toThrow();
  expect(() => verifyTurns(events(true), ["cat proof.txt"])).toThrow();
  expect(() => verifyTurns(events(), ["cat wrong.txt"])).toThrow();
  expect(() =>
    verifyTurns(
      events().filter((e) => e.type !== "turn/end"),
      ["cat proof.txt"],
    ),
  ).toThrow();
  expect(() => verifyTurns(events(), ["cat proof.txt", "another command"])).toThrow();
});

it("accepts the official Bash description without changing the required command", () => {
  expect(() => verifyTurns(events(false, true), ["cat proof.txt"])).not.toThrow();
});

it("does not mask a crash while an operator-requested shutdown is in progress", async () => {
  const { successfulHostExit } = await import("../src/evidence.ts");
  expect(successfulHostExit(0, true, false)).toBe(true);
  expect(successfulHostExit(130, true, true)).toBe(true);
  expect(successfulHostExit(1, true, true)).toBe(false);
  expect(successfulHostExit(null, true, true)).toBe(false);
  expect(successfulHostExit(130, false, true)).toBe(false);
  expect(successfulHostExit(130, true, false)).toBe(false);
});
