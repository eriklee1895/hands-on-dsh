import { expect, it } from "vitest";
import { Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { ApprovalRequestId } from "@deepseek-ai/dsh-user-approval";
import { createToolResultMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { verifyApproval, verifyCancelled } from "../src/control-evidence.ts";

function fixture(outcome: "rejected" | "allowed-once" | "cancel", mismatch = false) {
  const session = Session.create(SessionId("controls-fixture"));
  const callId = ToolCallId("call");
  const id = ApprovalRequestId("approval");
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 1 });
  if (outcome !== "cancel") {
    const initial = ToolCallId("initial");
    session.append("tool/call", {
      turn: 1,
      step: 1,
      callId: initial,
      name: "bash",
      arguments: JSON.stringify({ command: "fixed command", description: "Initial try" }),
    });
    session.append(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: initial,
          content: [{ type: "text", text: "[sandbox: file access denied under read-only mode]" }],
          isError: false,
        }),
      },
      { surfaceOp: "append" },
    );
    session.append("step/end", { turn: 1, step: 1 });
    session.append("step/start", { turn: 1, step: 2 });
  }
  const step = outcome === "cancel" ? 1 : 2;
  session.append("tool/call", {
    turn: 1,
    step,
    callId,
    name: "bash",
    arguments: JSON.stringify({
      command: "fixed command",
      description: "Experiment",
      ...(outcome === "cancel"
        ? { timeoutMs: 60000, run_in_background: false }
        : { sandbox_permissions: "workspace-write", justification: "Write the requested file" }),
    }),
  });
  if (outcome !== "cancel") {
    session.append("approval/asked", { id, toolName: "bash", callId });
    session.append("approval/decided", { id: mismatch ? ApprovalRequestId("wrong") : id, outcome });
  }
  session.append(
    "tool/result",
    {
      turn: 1,
      step,
      message: createToolResultMessage({
        callId,
        content: [{ type: "text", text: "controlled" }],
        isError: outcome !== "allowed-once",
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step });
  session.append("turn/end", {
    turn: 1,
    reason:
      outcome === "cancel" ? { kind: "aborted", reason: { kind: "user" } } : { kind: "completed" },
  });
  return session.snapshotEvents();
}
it("requires correlated rejected approval and an error result in a completed root turn", () => {
  expect(() => verifyApproval(fixture("rejected"), "fixed command", "rejected")).not.toThrow();
  expect(() => verifyApproval(fixture("allowed-once"), "fixed command", "rejected")).toThrow();
  expect(() => verifyApproval(fixture("rejected", true), "fixed command", "rejected")).toThrow();
});
it("requires a single allow-once decision before the successful matching tool result", () => {
  expect(() =>
    verifyApproval(fixture("allowed-once"), "fixed command", "allowed-once"),
  ).not.toThrow();
  expect(() =>
    verifyApproval(fixture("allowed-once"), "different command", "allowed-once"),
  ).toThrow();
  expect(() =>
    verifyApproval(
      fixture("allowed-once").filter((e) => e.type !== "approval/decided"),
      "fixed command",
      "allowed-once",
    ),
  ).toThrow();
});
it("does not mistake completed or incomplete work for user cancellation", () => {
  expect(() => verifyCancelled(fixture("cancel"), "fixed command")).not.toThrow();
  expect(() => verifyCancelled(fixture("allowed-once"), "fixed command")).toThrow();
  expect(() =>
    verifyCancelled(
      fixture("cancel").filter((e) => e.type !== "turn/end"),
      "fixed command",
    ),
  ).toThrow();
  const changed: SessionEvent[] = structuredClone([...fixture("cancel")]);
  const result = changed.find((e) => e.type === "tool/result");
  if (result?.type === "tool/result")
    result.data.message = createToolResultMessage({
      callId: ToolCallId("other"),
      content: [],
      isError: true,
    });
  expect(() => verifyCancelled(changed, "fixed command")).toThrow();
});

it("rejects an extra reconnect call or a cancelled turn posing as offline completion", async () => {
  const { verifyReconnected } = await import("../src/control-evidence.ts");
  const done: SessionEvent[] = structuredClone([...fixture("cancel")]);
  const result = done.find((e) => e.type === "tool/result");
  const end = done.find((e) => e.type === "turn/end");
  if (result?.type === "tool/result")
    result.data.message = createToolResultMessage({
      callId: ToolCallId("call"),
      content: [],
      isError: false,
    });
  if (end?.type === "turn/end") end.data.reason = { kind: "completed" };
  expect(() => verifyReconnected(done, "fixed command")).not.toThrow();
  expect(() =>
    verifyReconnected([...done, ...done.filter((e) => e.type === "tool/call")], "fixed command"),
  ).toThrow();
  expect(() => verifyReconnected(fixture("cancel"), "fixed command")).toThrow();
});
