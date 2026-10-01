import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createToolResultMessage, createUserMessage, ToolCallId } from "@deepseek-ai/dsh-llm";
import { Session, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import { ApprovalRequestId } from "@deepseek-ai/dsh-user-approval";
import {
  verifyAdmission,
  verifyCrashRepair,
  verifyLateWireCorrelation,
  verifyPendingApprovalCancel,
} from "../src/recovery-evidence.ts";

function admission() {
  const session = Session.create(SessionId("admission-fixture"));
  for (const [turn, requestId, text] of [
    [1, "after", "admitted"],
    [2, "concurrent", "duplicated"],
    [3, "concurrent", "duplicated"],
  ] as const) {
    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user", rpcId: requestId },
    });
    session.append("agent/inbox/spliced", { target: "next-turn", start: 0, inserted: [message] });
    session.append("turn/start", { turn });
    session.append("user/message", message, { surfaceOp: "append" });
    session.append("turn/end", { turn, reason: { kind: "completed" } });
  }
  return session.snapshotEvents();
}

it("reconciles a lost response from the durable request identity", () => {
  const events = admission();
  const requests = { beforeAbort: "before", afterAbort: "after", concurrent: "concurrent" };
  const prompts = { afterAbort: "admitted", concurrent: "duplicated" };
  expect(verifyAdmission(events, requests, prompts)).toEqual({
    beforeAbortAdmitted: 0,
    afterAbortAdmitted: 1,
    concurrentAdmitted: 2,
  });
  expect(() => verifyAdmission(events, { ...requests, beforeAbort: "after" }, prompts)).toThrow();
  expect(() => verifyAdmission(events, { ...requests, concurrent: "after" }, prompts)).toThrow();
});

it("requires an interrupted crash repair with an unknown tool result", () => {
  const session = Session.create(SessionId("crash-fixture"));
  const callId = ToolCallId("crash-call");
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 1 });
  session.append("tool/call", {
    turn: 1,
    step: 1,
    callId,
    name: "bash",
    arguments: JSON.stringify({ command: "controlled command" }),
  });
  session.append(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [], isError: true }),
      error: { name: "ToolOutcomeUnknownError", code: "TOOL_OUTCOME_UNKNOWN" },
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step: 1 });
  session.append("turn/end", { turn: 1, reason: { kind: "interrupted" } });
  const events = session.snapshotEvents();
  expect(verifyCrashRepair(events, "controlled command")).toEqual({
    recoveryCode: "TOOL_OUTCOME_UNKNOWN",
    turn: "interrupted",
  });
  expect(() => verifyCrashRepair(events, "different command")).toThrow();
  const completed = Session.create(SessionId("completed-fixture"));
  completed.append("turn/start", { turn: 1 });
  completed.append("step/start", { turn: 1, step: 1 });
  completed.append("tool/call", {
    turn: 1,
    step: 1,
    callId,
    name: "bash",
    arguments: JSON.stringify({ command: "controlled command" }),
  });
  completed.append(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [], isError: false }),
    },
    { surfaceOp: "append" },
  );
  completed.append("step/end", { turn: 1, step: 1 });
  completed.append("turn/end", { turn: 1, reason: { kind: "completed" } });
  expect(() => verifyCrashRepair(completed.snapshotEvents(), "controlled command")).toThrow();
});

it("rejects a late grant or another turn after a cancelled approval", () => {
  const session = Session.create(SessionId("late-approval-fixture"));
  const command = "printf '%s' 'STALE' >> approval-stale.txt";
  const first = ToolCallId("first");
  const retry = ToolCallId("retry");
  const id = ApprovalRequestId("approval");
  session.append("turn/start", { turn: 1 });
  session.append("step/start", { turn: 1, step: 1 });
  session.append("tool/call", {
    turn: 1,
    step: 1,
    callId: first,
    name: "bash",
    arguments: JSON.stringify({ command }),
  });
  session.append(
    "tool/result",
    {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: first,
        content: [{ type: "text", text: "[sandbox: file access denied under read-only mode]" }],
        isError: false,
      }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step: 1 });
  session.append("step/start", { turn: 1, step: 2 });
  session.append("tool/call", {
    turn: 1,
    step: 2,
    callId: retry,
    name: "bash",
    arguments: JSON.stringify({ command, sandbox_permissions: "workspace-write" }),
  });
  session.append("approval/asked", { id, toolName: "bash", callId: retry });
  session.append("approval/decided", { id, outcome: "cancelled" });
  session.append(
    "tool/result",
    {
      turn: 1,
      step: 2,
      message: createToolResultMessage({ callId: retry, content: [], isError: true }),
    },
    { surfaceOp: "append" },
  );
  session.append("step/end", { turn: 1, step: 2 });
  session.append("turn/end", { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } });
  const events = session.snapshotEvents();
  expect(verifyPendingApprovalCancel(events, command).lateGrantRecorded).toBe(false);
  const granted = structuredClone(events);
  const decision = granted.find((event) => event.type === "approval/decided");
  if (decision?.type === "approval/decided") decision.data.outcome = "allowed-once";
  expect(() => verifyPendingApprovalCancel(granted, command)).toThrow();
  const resumed = [...structuredClone(events)];
  resumed.push({
    type: "turn/end",
    seq: SessionSeq(resumed.at(-1)!.seq + 1),
    time: resumed.at(-1)!.time,
    data: { turn: 2, reason: { kind: "completed" } },
  });
  expect(() => verifyPendingApprovalCancel(resumed, command)).toThrow();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const clientIdHash = digest("client");
  const eventIdHash = digest("approval-event");
  const wrongEventHash = digest("random-event");
  const captured = {
    clientIdHash,
    eventIdHash,
    agentIdHash: digest("late-approval-fixture"),
    callIdHash: digest("retry"),
    toolName: "bash",
  };
  const valid = {
    clientIdHash,
    eventIdHash,
    rpcIdHash: digest("valid-rpc"),
    http: 200,
    rpcAccepted: true,
  };
  const negative = {
    clientIdHash,
    eventIdHash: wrongEventHash,
    rpcIdHash: digest("wrong-rpc"),
    http: 200,
    rpcAccepted: true,
  };
  const audit = {
    captures: [captured],
    posts: [
      { ...valid, outcome: "allowed-once" },
      { ...negative, outcome: "allowed-once" },
    ],
  };
  const receipt = {
    valid: { ...valid, errorCode: null },
    negative: { ...negative, errorCode: null },
  };
  expect(
    verifyLateWireCorrelation(audit, receipt, "late-approval-fixture", events)
      .stalePostMatchedCapture,
  ).toBe(true);
  expect(() =>
    verifyLateWireCorrelation(
      { ...audit, posts: [audit.posts[1]!, audit.posts[0]!] },
      receipt,
      "late-approval-fixture",
      events,
    ),
  ).toThrow();
  expect(() =>
    verifyLateWireCorrelation(
      { ...audit, captures: [{ ...captured, callIdHash: digest("unrelated-call") }] },
      receipt,
      "late-approval-fixture",
      events,
    ),
  ).toThrow();
  expect(() =>
    verifyLateWireCorrelation(
      {
        ...audit,
        posts: [{ ...audit.posts[0]!, clientIdHash: digest("unrelated-client") }, audit.posts[1]!],
      },
      receipt,
      "late-approval-fixture",
      events,
    ),
  ).toThrow();
});
