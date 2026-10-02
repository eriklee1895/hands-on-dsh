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

/** Check a cold-read forest against immutable stored history and direct-parent catalog facts. */
export function verifyForest(
  before: { root: Stored; child: Stored; grandchild: Stored },
  after: { root: Stored; child: Stored; grandchild: Stored },
  ids: { parentId: string; childId: string; grandchildId: string },
) {
  const expected = [
    ["root", ids.parentId, undefined],
    ["child", ids.childId, ids.parentId],
    ["grandchild", ids.grandchildId, ids.childId],
  ] as const;
  for (const [name, id, parentId] of expected) {
    const original = before[name];
    const reopened = after[name];
    assert.equal(original.header.version, 4);
    assert.equal(original.header.id, id);
    assert.equal(original.header.parentSession, parentId, `${name} direct parent`);
    assert.deepEqual(reopened.header, original.header, `${name} header changed on cold read`);
    assert.deepEqual(reopened.events, original.events, `${name} history changed on cold read`);
  }
  const parentCatalog = after.root.events.filter((event) => event.type === "subagent/catalog");
  const childCatalog = after.child.events.filter((event) => event.type === "subagent/catalog");
  const grandchildCatalog = after.grandchild.events.filter(
    (event) => event.type === "subagent/catalog",
  );
  assert.equal(parentCatalog.length, 1, "parent has exactly one direct child");
  assert.equal(childCatalog.length, 1, "child has exactly one direct child");
  assert.equal(grandchildCatalog.length, 0, "grandchild has no direct children");
  assert.equal(parentCatalog[0]!.data.childId, ids.childId);
  assert.equal(parentCatalog[0]!.data.childCreatedAt, after.child.header.createdAt);
  assert.equal(parentCatalog[0]!.data.mode, "continuable");
  assert.equal(childCatalog[0]!.data.childId, ids.grandchildId);
  assert.equal(childCatalog[0]!.data.childCreatedAt, after.grandchild.header.createdAt);
  assert.equal(childCatalog[0]!.data.mode, "continuable");
  for (const [name, catalog] of [
    ["child", parentCatalog[0]],
    ["grandchild", childCatalog[0]],
  ] as const) {
    const descriptors = after[name].events.filter((event) => event.type === "subagent/descriptor");
    assert.equal(descriptors.length, 1, `${name} has one descriptor`);
    assert.ok(descriptors[0]?.type === "subagent/descriptor");
    assert.equal(descriptors[0].data.mode, "continuable");
    assert.ok(catalog?.type === "subagent/catalog");
    assert.equal(catalog.data.label, descriptors[0].data.label, `${name} catalog label`);
  }
  return { edges: 2, immutableHistory: true };
}

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
