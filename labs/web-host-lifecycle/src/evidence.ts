/** Evidence checks, independent of browser presentation and model prose. */
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";

/** Strip authentication material and reject URLs outside this loopback-only experiment. */
export function publicUrl(launchUrl: string): string {
  const url = new URL(launchUrl);
  assert.equal(url.protocol, "http:");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  return url.origin + "/";
}
/** Require one exact successful Bash call per completed turn, with paired results. */
export function verifyTurns(events: readonly SessionEvent[], commands: readonly string[]) {
  const calls = events.filter((e) => e.type === "tool/call");
  const results = events.filter((e) => e.type === "tool/result");
  const starts = events.filter((e) => e.type === "turn/start");
  const ends = events.filter((e) => e.type === "turn/end");
  assert.equal(calls.length, commands.length);
  assert.equal(results.length, commands.length);
  assert.equal(starts.length, commands.length);
  assert.equal(ends.length, commands.length);
  for (let i = 0; i < commands.length; i++) {
    const call = calls[i]!;
    const end = ends[i]!;
    assert.equal(call.data.name, "bash");
    const args: unknown = JSON.parse(call.data.arguments);
    assert.ok(typeof args === "object" && args !== null && !Array.isArray(args));
    assert.ok("command" in args && args.command === commands[i]);
    assert.ok(Object.keys(args).every((key) => key === "command" || key === "description"));
    if ("description" in args) assert.equal(typeof args.description, "string");
    const result = results.find((e) => e.data.message.toolCallId === call.data.callId);
    assert.ok(result);
    assert.equal(result.data.message.isError, false);
    assert.equal(result.data.turn, call.data.turn);
    assert.equal(result.data.step, call.data.step);
    assert.equal(end.data.turn, call.data.turn);
    assert.equal(end.data.reason.kind, "completed");
    assert.equal(starts[i]!.data.turn, call.data.turn);
    assert.ok(starts[i]!.seq < call.seq && call.seq < result.seq && result.seq < end.seq);
  }
}
/** Read the persisted snapshot after the CLI owner has exited. */
export async function readStored(root: string, id: string) {
  const ctx = new Context();
  try {
    await ctx.plugin(Persistence, { root });
    const reader = await ctx.sessionPersistence.open(SessionId(id), "read");
    try {
      return { header: reader.header, events: (await reader.read()).events };
    } finally {
      await reader.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}

/** Classify the CLI's normal exit or an explicitly requested SIGINT exit code. */
export function successfulHostExit(
  code: number | null,
  ready: boolean,
  stopping: boolean,
): boolean {
  return ready && (code === 0 || (stopping && code === 130));
}
