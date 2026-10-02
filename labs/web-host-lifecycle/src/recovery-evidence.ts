/** Verify the durable outcomes of interrupted official Web control requests. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { SessionEvent } from "@deepseek-ai/dsh-session";

type UserEvent = SessionEvent<"user/message">;

function userRequests(events: readonly SessionEvent[], requestId: string): UserEvent[] {
  return events.filter(
    (event): event is UserEvent =>
      event.type === "user/message" &&
      event.data.source.kind === "user" &&
      "rpcId" in event.data.source &&
      event.data.source.rpcId === requestId,
  );
}

function inboxInsertions(events: readonly SessionEvent[], requestId: string): number {
  return events
    .flatMap((event) => (event.type === "agent/inbox/spliced" ? event.data.inserted : []))
    .filter(
      (message) =>
        message.source.kind === "user" &&
        "rpcId" in message.source &&
        message.source.rpcId === requestId,
    ).length;
}

function exactText(event: UserEvent, expected: string): void {
  assert.deepEqual(event.data.content, [{ type: "text", text: expected }]);
}

/** Reconcile a lost prompt response using its original request id and durable admission. */
export function verifyAdmission(
  events: readonly SessionEvent[],
  requests: {
    readonly beforeAbort: string;
    readonly afterAbort: string;
    readonly concurrent: string;
  },
  prompts: { readonly afterAbort: string; readonly concurrent: string },
) {
  assert.equal(userRequests(events, requests.beforeAbort).length, 0);
  assert.equal(inboxInsertions(events, requests.beforeAbort), 0);
  const admitted = userRequests(events, requests.afterAbort);
  assert.equal(admitted.length, 1);
  exactText(admitted[0]!, prompts.afterAbort);
  assert.equal(inboxInsertions(events, requests.afterAbort), 1);
  const concurrent = userRequests(events, requests.concurrent);
  assert.equal(concurrent.length, 2);
  concurrent.forEach((event) => exactText(event, prompts.concurrent));
  assert.equal(inboxInsertions(events, requests.concurrent), 2);
  assert.equal(events.filter((event) => event.type === "tool/call").length, 0);
  const ends = events.filter((event) => event.type === "turn/end");
  assert.equal(ends.length, 3);
  assert.ok(ends.every((event) => event.data.reason.kind === "completed"));
  return { beforeAbortAdmitted: 0, afterAbortAdmitted: 1, concurrentAdmitted: 2 };
}

/** Check one serial repeated request against its real Bash call and committed turn. */
export function verifySerialDuplicate(
  events: readonly SessionEvent[],
  prompt: string,
  command: string,
) {
  const messages = events.filter(
    (event): event is UserEvent =>
      event.type === "user/message" &&
      event.data.content.some((block) => block.type === "text" && block.text === prompt),
  );
  assert.equal(messages.length, 1);
  exactText(messages[0]!, prompt);
  const source = messages[0]!.data.source;
  assert.ok(source.kind === "user" && "rpcId" in source && typeof source.rpcId === "string");
  assert.equal(inboxInsertions(events, source.rpcId), 1);
  const calls = events.filter((event) => event.type === "tool/call");
  const results = events.filter((event) => event.type === "tool/result");
  const ends = events.filter((event) => event.type === "turn/end");
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(calls[0]!.data.name, "bash");
  const args: unknown = JSON.parse(calls[0]!.data.arguments);
  assert.ok(typeof args === "object" && args !== null && "command" in args);
  assert.equal(args.command, command);
  assert.equal(results[0]!.data.message.toolCallId, calls[0]!.data.callId);
  assert.equal(results[0]!.data.message.isError, false);
  assert.equal(ends[0]!.data.reason.kind, "completed");
  assert.ok(messages[0]!.seq < calls[0]!.seq && calls[0]!.seq < results[0]!.seq);
  assert.ok(results[0]!.seq < ends[0]!.seq);
  return { admittedPrompts: 1, calls: 1, completedTurns: 1 };
}

/** Require a withdrawn approval and user-aborted turn, with no later grant. */
export function verifyPendingApprovalCancel(events: readonly SessionEvent[], command: string) {
  const calls = events.filter((event) => event.type === "tool/call");
  const results = events.filter((event) => event.type === "tool/result");
  const asks = events.filter((event) => event.type === "approval/asked");
  const decisions = events.filter((event) => event.type === "approval/decided");
  const starts = events.filter((event) => event.type === "turn/start");
  const ends = events.filter((event) => event.type === "turn/end");
  assert.equal(calls.length, 2);
  assert.equal(results.length, 2);
  assert.equal(asks.length, 1);
  assert.equal(decisions.length, 1);
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  for (const call of calls) {
    const args: unknown = JSON.parse(call.data.arguments);
    assert.ok(typeof args === "object" && args !== null && "command" in args);
    assert.equal(args.command, command);
  }
  assert.equal(asks[0]!.data.callId, calls[1]!.data.callId);
  assert.ok(calls[0]!.seq < results[0]!.seq && results[0]!.seq < calls[1]!.seq);
  assert.ok(
    results[0]!.data.message.content.some(
      (block) =>
        block.type === "text" &&
        block.text.includes("[sandbox: file access denied under read-only mode]"),
    ),
  );
  assert.equal(decisions[0]!.data.id, asks[0]!.data.id);
  assert.equal(decisions[0]!.data.outcome, "cancelled");
  assert.ok(
    calls[1]!.seq < asks[0]!.seq &&
      asks[0]!.seq < decisions[0]!.seq &&
      decisions[0]!.seq < results[1]!.seq &&
      results[1]!.seq < ends[0]!.seq,
  );
  assert.equal(results[1]!.data.message.toolCallId, calls[1]!.data.callId);
  assert.equal(results[1]!.data.message.isError, true);
  assert.equal(ends[0]!.data.reason.kind, "aborted");
  if (ends[0]!.data.reason.kind === "aborted") {
    assert.equal(ends[0]!.data.reason.reason.kind, "user");
  }
  return { decision: "cancelled", turn: "aborted", lateGrantRecorded: false };
}

interface LateWireIdentity {
  readonly clientIdHash: string;
  readonly eventIdHash: string;
  readonly rpcIdHash: string;
}

interface LateWireResult extends LateWireIdentity {
  readonly http: number;
  readonly rpcAccepted: boolean;
  readonly errorCode: string | null;
}

interface LateWireAudit {
  readonly captures: readonly {
    readonly clientIdHash: string;
    readonly eventIdHash: string;
    readonly agentIdHash: string;
    readonly callIdHash: string;
    readonly toolName: string;
  }[];
  readonly posts: readonly (LateWireIdentity & {
    readonly outcome: string;
    readonly http: number;
    readonly rpcAccepted: boolean;
  })[];
}

/** Bind the live waterfall, actual outgoing body, receipt, and persisted approval. */
export function verifyLateWireCorrelation(
  audit: LateWireAudit,
  receipt: { readonly valid: LateWireResult; readonly negative: LateWireResult },
  sessionId: string,
  events: readonly SessionEvent[],
) {
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const hashPattern = /^[a-f0-9]{64}$/;
  assert.equal(audit.captures.length, 1);
  assert.equal(audit.posts.length, 2);
  const capture = audit.captures[0]!;
  assert.equal(capture.toolName, "bash");
  for (const value of [
    capture.clientIdHash,
    capture.eventIdHash,
    capture.agentIdHash,
    capture.callIdHash,
    ...audit.posts.flatMap((post) => [post.clientIdHash, post.eventIdHash, post.rpcIdHash]),
  ])
    assert.match(value, hashPattern);
  assert.equal(capture.agentIdHash, digest(sessionId));
  const asks = events.filter((event) => event.type === "approval/asked");
  assert.equal(asks.length, 1);
  assert.equal(asks[0]!.data.toolName, "bash");
  assert.ok(asks[0]!.data.callId);
  assert.equal(capture.callIdHash, digest(asks[0]!.data.callId));
  const [valid, negative] = audit.posts;
  assert.ok(valid && negative);
  assert.equal(valid.clientIdHash, capture.clientIdHash);
  assert.equal(valid.eventIdHash, capture.eventIdHash);
  assert.equal(negative.clientIdHash, capture.clientIdHash);
  assert.notEqual(negative.eventIdHash, capture.eventIdHash);
  assert.notEqual(negative.rpcIdHash, valid.rpcIdHash);
  for (const [post, browser] of [
    [valid, receipt.valid],
    [negative, receipt.negative],
  ] as const) {
    assert.equal(post.outcome, "allowed-once");
    assert.equal(post.http, 200);
    assert.equal(post.rpcAccepted, true);
    assert.equal(browser.clientIdHash, post.clientIdHash);
    assert.equal(browser.eventIdHash, post.eventIdHash);
    assert.equal(browser.rpcIdHash, post.rpcIdHash);
    assert.equal(browser.http, 200);
    assert.equal(browser.rpcAccepted, true);
    assert.equal(browser.errorCode, null);
  }
  return {
    capturedApprovalBoundToSession: true,
    capturedCallBoundToDurableAsk: true,
    stalePostMatchedCapture: true,
    randomEventRejectedByCorrelation: true,
    bothWireResponsesAccepted: true,
  };
}

/** Require official crash repair; an error result cannot prove the external effect was absent. */
export function verifyCrashRepair(events: readonly SessionEvent[], command: string) {
  const calls = events.filter((event) => event.type === "tool/call");
  const results = events.filter((event) => event.type === "tool/result");
  const ends = events.filter((event) => event.type === "turn/end");
  assert.equal(calls.length, 1);
  assert.equal(results.length, 1);
  assert.equal(ends.length, 1);
  const args: unknown = JSON.parse(calls[0]!.data.arguments);
  assert.ok(typeof args === "object" && args !== null && "command" in args);
  assert.equal(args.command, command);
  assert.equal(results[0]!.data.message.toolCallId, calls[0]!.data.callId);
  assert.equal(results[0]!.data.message.isError, true);
  assert.equal(results[0]!.data.error?.code, "TOOL_OUTCOME_UNKNOWN");
  assert.equal(ends[0]!.data.reason.kind, "interrupted");
  assert.ok(calls[0]!.seq < results[0]!.seq && results[0]!.seq < ends[0]!.seq);
  return { recoveryCode: "TOOL_OUTCOME_UNKNOWN", turn: "interrupted" };
}
