import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthoritativeStore } from "../src/server/store.ts";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function store() {
  const root = await mkdtemp(join(tmpdir(), "agui-store-"));
  roots.push(root);
  return { root, db: new AuthoritativeStore(join(root, "app.db")) };
}

describe("authoritative SQLite store", () => {
  test("admits immutable idempotent runs and monotonic cursor events", async () => {
    const { db } = await store();
    db.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    db.createConversation({ id: "c2", title: "Two", dshSessionRef: "session-2" });
    const first = db.admitRun({
      id: "r1",
      conversationId: "c1",
      request: { message: " hello ", extra: { b: 2, a: 1 } },
    });
    expect(first.created).toBe(true);
    expect(
      db.admitRun({
        id: "r1",
        conversationId: "c1",
        request: { extra: { a: 1, b: 2 }, message: " hello " },
      }),
    ).toMatchObject({ created: false, conflict: true });
    expect(() =>
      db.admitRun({ id: "r1", conversationId: "c1", request: { message: "different" } }),
    ).toThrow(/fingerprint/);
    expect(() =>
      db.admitRun({
        id: "r1",
        conversationId: "c2",
        request: { extra: { a: 1, b: 2 }, message: " hello " },
      }),
    ).toThrow(/conversation/);
    expect(db.listEvents("r1", 0, 10).map((event) => event.seq)).toEqual([1]);
    expect(db.appendEvent("r1", "raw-dsh", "one", { n: 1 })).toBe(2);
    expect(db.appendEvent("r1", "ag-ui", "two", { n: 2 })).toBe(3);
    expect(db.listEvents("r1", 1, 1).map((event) => event.seq)).toEqual([2]);
    db.close();
  });

  test("stores immutable artifact bytes, hash and safe metadata across reopen", async () => {
    const { root, db } = await store();
    db.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    db.admitRun({ id: "r1", conversationId: "c1", request: { message: "proof" } });
    const bytes = Buffer.from("immutable proof\n");
    const artifact = db.saveArtifact({
      id: "a1",
      runId: "r1",
      filename: "proof.txt",
      mediaType: "text/plain",
      bytes,
    });
    expect(artifact.size).toBe(bytes.byteLength);
    expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(() =>
      db.saveArtifact({
        id: "a1",
        runId: "r1",
        filename: "proof.txt",
        mediaType: "text/plain",
        bytes,
      }),
    ).toThrow();
    expect(() =>
      db.saveArtifact({
        id: "a2",
        runId: "r1",
        filename: "../escape",
        mediaType: "text/plain",
        bytes,
      }),
    ).toThrow(/filename/);
    db.close();
    const reopened = new AuthoritativeStore(join(root, "app.db"));
    expect(reopened.getArtifact("a1")?.bytes).toEqual(bytes);
    reopened.close();
  });

  test("rolls back invalid JSON appends without consuming sequence numbers", async () => {
    const { db } = await store();
    db.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    db.admitRun({ id: "r1", conversationId: "c1", request: { message: "one" } });
    expect(() => db.appendEvent("r1", "business", "invalid", { value: 1n })).toThrow(/JSON/);
    expect(db.appendEvent("r1", "business", "valid", { value: 2 })).toBe(2);
    expect(() =>
      db.testOnlyRun(
        "INSERT INTO run_events(run_id,seq,channel,type,payload_json,created_at) VALUES(?,?,?,?,?,?)",
        "r1",
        99,
        "business",
        "invalid-db-json",
        "not-json",
        Date.now(),
      ),
    ).toThrow(/CHECK constraint/);
    expect(() => db.admitRun({ id: "missing", conversationId: "absent", request: {} })).toThrow(
      /not found/,
    );
    expect(db.getRun("missing")).toBeUndefined();
    db.close();
    db.close();
  });

  test("atomically finishes a running run once with terminal diagnostics and event", async () => {
    const { db } = await store();
    db.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    db.admitRun({ id: "r1", conversationId: "c1", request: { message: "one" } });
    db.startRun("r1");
    expect(db.listEvents("r1", 0, 20).slice(-2)).toMatchObject([
      { channel: "business", type: "running" },
      { channel: "ag-ui", type: "RUN_STARTED", payload: { threadId: "c1", runId: "r1" } },
    ]);
    expect(() => db.startRun("r1")).toThrow(/not queued/);
    db.finishRun("r1", "failed", { code: "MODEL_ERROR", message: "failed safely" });
    expect(db.getRun("r1")?.status).toBe("failed");
    expect(db.listEvents("r1", 0, 20).slice(-2)).toMatchObject([
      {
        channel: "business",
        type: "failed",
        payload: { status: "failed", code: "MODEL_ERROR", message: "failed safely" },
      },
      {
        channel: "ag-ui",
        type: "RUN_ERROR",
        payload: { type: "RUN_ERROR", code: "MODEL_ERROR", message: "failed safely" },
      },
    ]);
    const count = db.listEvents("r1", 0, 20).length;
    expect(() => db.finishRun("r1", "succeeded")).toThrow(/not running/);
    expect(db.listEvents("r1", 0, 20)).toHaveLength(count);
    db.admitRun({ id: "r2", conversationId: "c1", request: { message: "two" } });
    db.startRun("r2");
    db.finishRun("r2", "succeeded");
    expect(db.listEvents("r2", 0, 20).at(-1)).toMatchObject({
      channel: "ag-ui",
      type: "RUN_FINISHED",
      payload: { type: "RUN_FINISHED", threadId: "c1", runId: "r2", outcome: { type: "success" } },
    });
    for (const [id, diagnostics, expected] of [
      ["r3", undefined, { message: "Run failed" }],
      ["r4", { message: "message only" }, { message: "message only" }],
      ["r5", { code: "CODE_ONLY" }, { message: "Run failed", code: "CODE_ONLY" }],
    ] as const) {
      db.admitRun({ id, conversationId: "c1", request: { message: id } });
      db.startRun(id);
      db.finishRun(id, "failed", diagnostics);
      const payload = db.listEvents(id, 0, 20).at(-1)?.payload as Record<string, unknown>;
      expect(payload).toMatchObject({ type: "RUN_ERROR", ...expected });
      expect(Object.values(payload)).not.toContain(undefined);
    }
    db.close();
  });

  test("aggregates a rollback hook failure while leaving the database usable", async () => {
    const root = await mkdtemp(join(tmpdir(), "agui-rollback-"));
    roots.push(root);
    const db = new AuthoritativeStore(join(root, "app.db"), {
      rollbackFailureForTests: () => {
        throw new Error("rollback hook failed");
      },
    });
    db.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    db.admitRun({ id: "r1", conversationId: "c1", request: { message: "one" } });
    const error = (() => {
      try {
        db.appendEvent("r1", "business", "invalid", { value: 1n });
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect(db.appendEvent("r1", "business", "valid", {})).toBe(2);
    db.close();
  });

  test("refuses an unknown newer user_version without creating schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "agui-newer-schema-"));
    roots.push(root);
    const path = join(root, "app.db");
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA user_version=3");
    raw.close();
    expect(() => new AuthoritativeStore(path)).toThrow(/unsupported schema version 3/);
    const inspected = new DatabaseSync(path);
    expect(inspected.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual(
      [],
    );
    inspected.close();
  });

  test("orders same-millisecond runs by monotonic per-conversation admission sequence", async () => {
    const { db } = await store();
    const now = vi.spyOn(Date, "now").mockReturnValue(1234);
    try {
      db.createConversation({ id: "c1", title: "Order", dshSessionRef: "session-1" });
      db.admitRun({ id: "z-run", conversationId: "c1", request: { message: "first" } });
      db.startRun("z-run");
      db.finishRun("z-run", "succeeded");
      db.admitRun({ id: "a-run", conversationId: "c1", request: { message: "second" } });
      db.startRun("a-run");
      db.finishRun("a-run", "succeeded");
    } finally {
      now.mockRestore();
    }
    expect(db.listRunsByConversation("c1").map((run) => [run.id, run.admissionSeq])).toEqual([
      ["z-run", 1],
      ["a-run", 2],
    ]);
    db.close();
  });

  test("migrates v1 runs to deterministic admission sequences before admitting the next run", async () => {
    const root = await mkdtemp(join(tmpdir(), "agui-v1-migration-"));
    roots.push(root);
    const path = join(root, "app.db");
    const raw = new DatabaseSync(path);
    raw.exec(`
      CREATE TABLE conversations(
        id TEXT PRIMARY KEY, title TEXT NOT NULL, dsh_session_ref TEXT NOT NULL,
        session_generation INTEGER NOT NULL DEFAULT 1, recovery_state TEXT NOT NULL DEFAULT 'active',
        recovery_acknowledged_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE runs(
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, request_json TEXT NOT NULL,
        fingerprint TEXT NOT NULL, dsh_session_ref TEXT NOT NULL, status TEXT NOT NULL,
        terminal_code TEXT, terminal_message TEXT, next_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE run_events(
        run_id TEXT NOT NULL, seq INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT NOT NULL,
        payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(run_id,seq)
      ) STRICT;
      INSERT INTO conversations VALUES('c1','Old','session-1',1,'active',NULL,1,1);
      INSERT INTO runs VALUES('z-old','c1','{"message":"z"}','f1','session-1','succeeded',NULL,NULL,0,1,1);
      INSERT INTO runs VALUES('a-old','c1','{"message":"a"}','f2','session-1','succeeded',NULL,NULL,0,1,1);
      PRAGMA user_version=1;
    `);
    raw.close();
    const migrated = new AuthoritativeStore(path);
    expect(migrated.listRunsByConversation("c1").map((run) => [run.id, run.admissionSeq])).toEqual([
      ["a-old", 1],
      ["z-old", 2],
    ]);
    expect(
      migrated.admitRun({ id: "new", conversationId: "c1", request: { message: "new" } }).run
        .admissionSeq,
    ).toBe(3);
    migrated.close();
  });

  test("rejects nested and Promise transaction callbacks without leaving a transaction open", async () => {
    const { db } = await store();
    expect(() => db.testOnlyTransaction(() => db.testOnlyTransaction(() => 1))).toThrow(/nested/);
    expect(() => db.testOnlyTransaction(() => Promise.resolve(1))).toThrow(/synchronous/);
    db.createConversation({ id: "after", title: "After", dshSessionRef: "after-session" });
    db.close();
  });

  test("recovers queued payload and blocks unknown execution until atomic acknowledgement", async () => {
    const { root, db } = await store();
    db.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    db.createConversation({ id: "c2", title: "Two", dshSessionRef: "session-queued" });
    db.admitRun({ id: "queued", conversationId: "c2", request: { message: "queued input" } });
    db.admitRun({ id: "running", conversationId: "c1", request: { message: "running input" } });
    db.startRun("running");
    expect(() =>
      db.admitRun({ id: "busy", conversationId: "c1", request: { message: "busy" } }),
    ).toThrow(/UNIQUE/);
    db.close();
    const recovered = new AuthoritativeStore(join(root, "app.db"));
    expect(recovered.recoverStartup()).toEqual([
      { runId: "queued", request: { message: "queued input" } },
    ]);
    expect(recovered.getRun("running")?.status).toBe("execution_unknown");
    expect(recovered.getConversation("c1")?.recoveryState).toBe("blocked");
    expect(
      recovered
        .listEvents("running", 0, 20)
        .slice(-2)
        .map((event) => [event.channel, event.type]),
    ).toEqual([
      ["business", "execution_unknown"],
      ["ag-ui", "RUN_ERROR"],
    ]);
    expect(() =>
      recovered.admitRun({ id: "blocked", conversationId: "c1", request: { message: "no" } }),
    ).toThrow(/blocked/);
    const before = recovered.listEvents("running", 0, 20).length;
    expect(() => recovered.acknowledgeUnknown("c1", "session-1")).toThrow(/new session/);
    const ack = recovered.acknowledgeUnknown("c1", "session-2");
    expect(ack).toMatchObject({
      recoveryState: "active",
      sessionGeneration: 2,
      dshSessionRef: "session-2",
    });
    expect(recovered.listEvents("running", 0, 20)).toHaveLength(before);
    expect(recovered.listConversationEvents("c1")).toMatchObject([
      {
        seq: 1,
        type: "execution_unknown_acknowledged",
        payload: {
          previousSessionRef: "session-1",
          newSessionRef: "session-2",
          generation: 2,
        },
      },
    ]);
    expect(() => recovered.acknowledgeUnknown("c1", "session-2")).toThrow(/blocked/);
    recovered.close();
  });
});
