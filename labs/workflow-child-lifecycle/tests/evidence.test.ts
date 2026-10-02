import { expect, it } from "vitest";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import { createToolResultMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { verifyBash } from "../src/evidence.ts";

function evidence(isError = false, matchingId = true) {
  const session = Session.create(SessionId("tool-evidence"));
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 1 });
  const callId = ToolCallId("call");
  session.append("tool/call", {
    turn: 1,
    step: 1,
    callId,
    name: "bash",
    arguments: JSON.stringify({ command: "cat proof.txt" }),
  });
  session.append(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: matchingId ? callId : ToolCallId("other"),
        content: [{ type: "text", text: "proof" }],
        isError,
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  return session.snapshotEvents();
}
it("accepts matching successful Bash evidence and rejects an extra or different command", () => {
  const events = evidence();
  expect(() => verifyBash(events, "cat proof.txt")).not.toThrow();
  expect(() => verifyBash(events, "cat another.txt")).toThrow();
  expect(() =>
    verifyBash(
      [...events, ...events.filter((event) => event.type === "tool/call")],
      "cat proof.txt",
    ),
  ).toThrow();
});
it("rejects a tool error, mismatched result, or missing completed turn", () => {
  expect(() => verifyBash(evidence(true), "cat proof.txt")).toThrow();
  expect(() => verifyBash(evidence(false, false), "cat proof.txt")).toThrow();
  expect(() =>
    verifyBash(
      evidence().filter((event) => event.type !== "turn/end"),
      "cat proof.txt",
    ),
  ).toThrow();
});
