/** Public-backend reads and evidence checks shared by controlled and live runs. */
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";

export async function readStored(root: string, id: string) {
  const ctx = new Context();
  try {
    await ctx.plugin(Persistence, { root, compression: "none" });
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
export type Stored = Awaited<ReturnType<typeof readStored>>;
/** Require unchanged historical events, one durable identity, and a new completed child turn. */
export function verifyCold(
  before: Stored,
  after: Stored,
  parent: Stored,
  parentId: string,
  childId: string,
) {
  for (const log of [before, after]) {
    assert.equal(log.header.version, 4);
    assert.equal(log.header.id, childId);
    assert.equal(log.header.parentSession, parentId);
    assert.equal(
      log.events.filter(
        (event) => event.type === "subagent/descriptor" && event.data.mode === "continuable",
      ).length,
      1,
    );
  }
  assert.equal(parent.header.id, parentId);
  assert.deepEqual(after.header, before.header);
  assert.ok(after.events.length > before.events.length, "resume appended events");
  assert.deepEqual(
    after.events.slice(0, before.events.length),
    before.events,
    "historical prefix unchanged",
  );
  const catalogs = parent.events.filter(
    (event) => event.type === "subagent/catalog" && event.data.childId === childId,
  );
  assert.equal(catalogs.length, 1, "no replacement child catalog entry");
  assert.ok(catalogs[0]?.type === "subagent/catalog");
  assert.equal(catalogs[0].data.mode, "continuable");
  const ends = after.events.filter((event) => event.type === "turn/end");
  assert.equal(ends.length, 2);
  for (const end of ends) assert.equal(end.data.reason.kind, "completed");
  const delta = after.events.slice(before.events.length);
  assert.equal(delta.filter((event) => event.type === "turn/start").length, 1);
  assert.equal(delta.filter((event) => event.type === "turn/end").length, 1);
  const delivery = delta.filter(
    (event) => event.type === "user/message" && event.data.source.kind === "agent-message",
  );
  assert.equal(delivery.length, 1);
  assert.ok(
    delivery[0]?.type === "user/message" && delivery[0].data.source.kind === "agent-message",
  );
  assert.equal(delivery[0].data.source.senderSessionId, parentId);
  return {
    prefixUnchanged: true,
    childId,
    beforeEvents: before.events.length,
    afterEvents: after.events.length,
    completedTurns: ends.length,
  };
}

/** Require exactly one successful bash call, with the expected command and a completed turn. */
export function verifyBash(events: readonly SessionEvent[], command: string) {
  const calls = events.filter((event) => event.type === "tool/call");
  const results = events.filter((event) => event.type === "tool/result");
  assert.equal(calls.length, 1, "one bash call");
  assert.equal(results.length, 1, "one tool result");
  assert.equal(calls[0]!.data.name, "bash");
  assert.deepEqual(JSON.parse(calls[0]!.data.arguments), { command });
  assert.equal(results[0]!.data.message.toolCallId, calls[0]!.data.callId);
  assert.equal(results[0]!.data.message.isError, false);
  assert.ok(results[0]!.seq > calls[0]!.seq);
  assert.equal(
    events.filter((event) => event.type === "turn/end").at(-1)?.data.reason.kind,
    "completed",
  );
}
