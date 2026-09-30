/** Check settled controls without treating UI acknowledgements as terminal results. */
import assert from "node:assert/strict";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-user-approval";

function toolTurn(events: readonly SessionEvent[], command: string, count: number) {
  const calls = events.filter((e) => e.type === "tool/call");
  const results = events.filter((e) => e.type === "tool/result");
  const starts = events.filter((e) => e.type === "turn/start");
  const ends = events.filter((e) => e.type === "turn/end");
  assert.equal(calls.length, count);
  assert.equal(results.length, count);
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  const end = ends[0]!;
  const pairs = calls.map((call) => {
    assert.equal(call.data.name, "bash");
    const args: unknown = JSON.parse(call.data.arguments);
    assert.ok(
      typeof args === "object" && args !== null && "command" in args && args.command === command,
    );
    const matches = results.filter((e) => e.data.message.toolCallId === call.data.callId);
    assert.equal(matches.length, 1);
    const result = matches[0]!;
    assert.equal(result.data.turn, call.data.turn);
    assert.equal(result.data.step, call.data.step);
    assert.equal(starts[0]!.data.turn, call.data.turn);
    assert.equal(end.data.turn, call.data.turn);
    assert.ok(starts[0]!.seq < call.seq && call.seq < result.seq && result.seq < end.seq);
    return { call, result, args };
  });
  assert.equal(new Set(calls.map((e) => e.data.callId)).size, count);
  return { pairs, end };
}
function fields(args: object, extra: readonly string[]) {
  assert.ok(Object.keys(args).every((k) => ["command", "description", ...extra].includes(k)));
  if ("description" in args) assert.equal(typeof args.description, "string");
}
/** Verify a real readonly denial followed by exactly one request for a wider mode. */
export function verifyApproval(
  events: readonly SessionEvent[],
  command: string,
  outcome: "rejected" | "allowed-once",
) {
  const { pairs, end } = toolTurn(events, command, 2);
  const initial = pairs[0]!;
  const retry = pairs[1]!;
  fields(initial.args, []);
  fields(retry.args, ["sandbox_permissions", "justification"]);
  assert.ok(
    "sandbox_permissions" in retry.args && retry.args.sandbox_permissions === "workspace-write",
  );
  assert.ok(
    "justification" in retry.args &&
      typeof retry.args.justification === "string" &&
      retry.args.justification.trim().length > 0,
  );
  assert.ok(
    initial.result.data.message.content.some(
      (b) =>
        b.type === "text" && b.text.includes("[sandbox: file access denied under read-only mode]"),
    ),
  );
  assert.ok(initial.result.seq < retry.call.seq);
  const asks = events.filter((e) => e.type === "approval/asked");
  const decisions = events.filter((e) => e.type === "approval/decided");
  assert.equal(asks.length, 1);
  assert.equal(decisions.length, 1);
  const ask = asks[0]!;
  const decision = decisions[0]!;
  assert.equal(ask.data.callId, retry.call.data.callId);
  assert.equal(ask.data.toolName, "bash");
  assert.equal(decision.data.id, ask.data.id);
  assert.equal(decision.data.outcome, outcome);
  assert.ok(retry.call.seq < ask.seq && ask.seq < decision.seq && decision.seq < retry.result.seq);
  assert.equal(retry.result.data.message.isError, outcome === "rejected");
  assert.equal(end.data.reason.kind, "completed");
  return {
    approvalId: ask.data.id,
    outcome,
    turn: end.data.turn,
    toolCalls: 2,
    toolCallId: retry.call.data.callId,
  };
}
function delayedTurn(events: readonly SessionEvent[], command: string) {
  const observed = toolTurn(events, command, 1);
  const pair = observed.pairs[0]!;
  fields(pair.args, ["timeoutMs", "run_in_background"]);
  assert.ok("timeoutMs" in pair.args && pair.args.timeoutMs === 60000);
  assert.ok("run_in_background" in pair.args && pair.args.run_in_background === false);
  assert.equal(
    events.filter((e) => e.type === "approval/asked" || e.type === "approval/decided").length,
    0,
  );
  return { ...pair, end: observed.end };
}
/** Require the user-caused aborted turn and failed call after foreground cancellation. */
export function verifyCancelled(events: readonly SessionEvent[], command: string) {
  const { call, result, end } = delayedTurn(events, command);
  assert.equal(result.data.message.isError, true);
  assert.ok(end.data.reason.kind === "aborted");
  assert.equal(end.data.reason.reason.kind, "user");
  return { turn: end.data.turn, toolCallId: call.data.callId, reason: end.data.reason };
}
/** Require one completed foreground call; the external append count checks repeated side effects. */
export function verifyReconnected(events: readonly SessionEvent[], command: string) {
  const { call, result, end } = delayedTurn(events, command);
  assert.equal(result.data.message.isError, false);
  assert.equal(end.data.reason.kind, "completed");
  return { turn: end.data.turn, toolCallId: call.data.callId, completed: true };
}
