import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { basename } from "node:path";
import {
  EventType,
  RunErrorEventSchema,
  RunFinishedEventSchema,
  RunStartedEventSchema,
} from "@ag-ui/core";
import type { EventChannel, RecoveryState, RunStatus } from "../shared/domain.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface Conversation {
  id: string;
  title: string;
  dshSessionRef: string;
  sessionGeneration: number;
  recoveryState: RecoveryState;
}

export interface Run {
  id: string;
  conversationId: string;
  admissionSeq: number;
  request: Json;
  fingerprint: string;
  status: RunStatus;
  dshSessionRef: string;
}

export interface RunEvent {
  runId: string;
  seq: number;
  channel: EventChannel;
  type: string;
  payload: Json;
  createdAt: number;
}

function normalize(value: unknown): Json {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalize(entry)]),
    );
  }
  throw new TypeError("request/payload must be JSON-serializable");
}

function encode(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function decode(text: unknown): Json {
  if (typeof text !== "string") throw new TypeError("stored JSON must be text");
  return normalize(JSON.parse(text));
}

function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export class AuthoritativeStore {
  private readonly database: DatabaseSync;
  private readonly rollbackFailureForTests?: () => void;

  constructor(path: string, options: { rollbackFailureForTests?: () => void } = {}) {
    this.database = new DatabaseSync(path);
    this.rollbackFailureForTests = options.rollbackFailureForTests;
    try {
      this.migrate();
    } catch (error) {
      if (this.database.isOpen) this.database.close();
      throw error;
    }
    this.database.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
  }

  private migrate(): void {
    const version = Number(
      (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    );
    if (version > 2) throw new Error(`unsupported schema version ${version}`);
    if (version === 2) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (version === 1) {
        this.database.exec(`
        ALTER TABLE conversations ADD COLUMN next_admission_seq INTEGER NOT NULL DEFAULT 0 CHECK(next_admission_seq >= 0);
        ALTER TABLE runs ADD COLUMN admission_seq INTEGER NOT NULL DEFAULT 0 CHECK(admission_seq >= 0);
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at,id) AS seq
          FROM runs
        )
        UPDATE runs SET admission_seq=(SELECT seq FROM ranked WHERE ranked.id=runs.id);
        UPDATE conversations SET next_admission_seq=COALESCE(
          (SELECT MAX(admission_seq) FROM runs WHERE runs.conversation_id=conversations.id),0
        );
        CREATE UNIQUE INDEX runs_conversation_admission ON runs(conversation_id,admission_seq);
        CREATE TRIGGER runs_admission_positive_insert BEFORE INSERT ON runs
          WHEN NEW.admission_seq <= 0 BEGIN SELECT RAISE(ABORT,'admission_seq must be positive'); END;
        CREATE TRIGGER runs_admission_positive_update BEFORE UPDATE OF admission_seq ON runs
          WHEN NEW.admission_seq <= 0 BEGIN SELECT RAISE(ABORT,'admission_seq must be positive'); END;
        PRAGMA user_version=2;
        `);
        this.database.exec("COMMIT");
        return;
      }
      this.database.exec(`
      CREATE TABLE conversations(
        id TEXT PRIMARY KEY, title TEXT NOT NULL, dsh_session_ref TEXT NOT NULL,
        session_generation INTEGER NOT NULL DEFAULT 1 CHECK(session_generation > 0),
        next_admission_seq INTEGER NOT NULL DEFAULT 0 CHECK(next_admission_seq >= 0),
        recovery_state TEXT NOT NULL DEFAULT 'active' CHECK(recovery_state IN ('active','blocked')),
        recovery_acknowledged_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE session_refs(ref TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), generation INTEGER NOT NULL) STRICT;
      CREATE TABLE conversation_events(conversation_id TEXT NOT NULL REFERENCES conversations(id), seq INTEGER NOT NULL,
        type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at INTEGER NOT NULL,
        PRIMARY KEY(conversation_id,seq)) STRICT;
      CREATE TABLE runs(
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        request_json TEXT NOT NULL CHECK(json_valid(request_json)), fingerprint TEXT NOT NULL, dsh_session_ref TEXT NOT NULL,
        admission_seq INTEGER NOT NULL CHECK(admission_seq > 0),
        status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','execution_unknown')),
        terminal_code TEXT, terminal_message TEXT, next_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX one_active_run_per_conversation ON runs(conversation_id) WHERE status IN ('queued','running');
      CREATE UNIQUE INDEX runs_conversation_admission ON runs(conversation_id,admission_seq);
      CREATE TRIGGER runs_admission_positive_insert BEFORE INSERT ON runs
        WHEN NEW.admission_seq <= 0 BEGIN SELECT RAISE(ABORT,'admission_seq must be positive'); END;
      CREATE TRIGGER runs_admission_positive_update BEFORE UPDATE OF admission_seq ON runs
        WHEN NEW.admission_seq <= 0 BEGIN SELECT RAISE(ABORT,'admission_seq must be positive'); END;
      CREATE TABLE run_events(
        run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL CHECK(seq > 0),
        channel TEXT NOT NULL CHECK(channel IN ('business','raw-dsh','ag-ui')),
        type TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, seq)
      ) STRICT;
      CREATE TABLE artifacts(
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), filename TEXT NOT NULL,
        media_type TEXT NOT NULL, bytes BLOB NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version=2;
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private transaction<T>(work: () => T): T {
    if (this.database.isTransaction) throw new Error("nested transaction is not allowed");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      if (value instanceof Promise) throw new Error("transaction callback must be synchronous");
      this.database.exec("COMMIT");
      return value;
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      try {
        this.rollbackFailureForTests?.();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      if (this.database.isTransaction) {
        try {
          this.database.exec("ROLLBACK");
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0)
        throw new AggregateError([error, ...rollbackErrors], "transaction and rollback failed");
      throw error;
    }
  }

  testOnlyTransaction<T>(work: () => T): T {
    return this.transaction(work);
  }

  testOnlyRun(sql: string, ...values: Array<string | number | null>): void {
    this.database.prepare(sql).run(...values);
  }

  testOnlyAppendRepeatedEvent(
    runId: string,
    count: number,
    channel: EventChannel,
    type: string,
    payload: unknown,
  ): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > 20_000)
      throw new Error("invalid repeated event count");
    this.transaction(() => {
      for (let index = 0; index < count; index += 1)
        this.insertEvent(runId, channel, type, payload);
    });
  }

  createConversation(input: { id: string; title: string; dshSessionRef: string }): Conversation {
    return this.transaction(() => {
      const now = Date.now();
      this.database
        .prepare(`INSERT INTO conversations
      (id,title,dsh_session_ref,session_generation,recovery_state,created_at,updated_at)
      VALUES(?,?,?,1,'active',?,?)`)
        .run(input.id, input.title, input.dshSessionRef, now, now);
      this.database
        .prepare("INSERT INTO session_refs(ref,conversation_id,generation) VALUES(?,?,1)")
        .run(input.dshSessionRef, input.id);
      return this.getConversation(input.id)!;
    });
  }

  getConversation(id: string): Conversation | undefined {
    const row = this.database.prepare("SELECT * FROM conversations WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          title: String(row.title),
          dshSessionRef: String(row.dsh_session_ref),
          sessionGeneration: Number(row.session_generation),
          recoveryState: row.recovery_state as RecoveryState,
        };
  }

  listConversations(): Conversation[] {
    return (
      this.database.prepare("SELECT id FROM conversations ORDER BY created_at,id").all() as Array<{
        id: string;
      }>
    ).map((row) => this.getConversation(row.id)!);
  }

  listArtifacts(
    runId: string,
  ): Array<{ id: string; filename: string; mediaType: string; size: number; sha256: string }> {
    return (
      this.database
        .prepare(
          "SELECT id,filename,media_type,size,sha256 FROM artifacts WHERE run_id=? ORDER BY created_at,id",
        )
        .all(runId) as Array<Record<string, unknown>>
    ).map((row) => ({
      id: String(row.id),
      filename: String(row.filename),
      mediaType: String(row.media_type),
      size: Number(row.size),
      sha256: String(row.sha256),
    }));
  }

  listRunsByConversation(conversationId: string): Run[] {
    return (
      this.database
        .prepare("SELECT id FROM runs WHERE conversation_id=? ORDER BY admission_seq")
        .all(conversationId) as Array<{ id: string }>
    ).map((row) => this.getRun(row.id)!);
  }

  admitRun(input: { id: string; conversationId: string; request: unknown }): {
    created: boolean;
    conflict: boolean;
    run: Run;
  } {
    const requestJson = encode(input.request);
    const requestFingerprint = fingerprint(requestJson);
    return this.transaction(() => {
      const existing = this.getRun(input.id);
      if (existing !== undefined) {
        if (existing.conversationId !== input.conversationId)
          throw new Error("run id conversation conflict");
        if (existing.fingerprint !== requestFingerprint)
          throw new Error("run id fingerprint conflict");
        return { created: false, conflict: true, run: existing };
      }
      const conversation = this.getConversation(input.conversationId);
      if (conversation === undefined) throw new Error("conversation not found");
      if (conversation.recoveryState === "blocked") throw new Error("conversation is blocked");
      const now = Date.now();
      const admission = this.database
        .prepare(`UPDATE conversations SET next_admission_seq=next_admission_seq+1
        WHERE id=? RETURNING next_admission_seq AS seq`)
        .get(input.conversationId) as { seq: number } | undefined;
      if (admission === undefined) throw new Error("conversation admission sequence conflict");
      this.database
        .prepare(`INSERT INTO runs
        (id,conversation_id,request_json,fingerprint,dsh_session_ref,admission_seq,status,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'queued',?,?)`)
        .run(
          input.id,
          input.conversationId,
          requestJson,
          requestFingerprint,
          conversation.dshSessionRef,
          admission.seq,
          now,
          now,
        );
      this.insertEvent(input.id, "business", "queued", { request: normalize(input.request) });
      return { created: true, conflict: false, run: this.getRun(input.id)! };
    });
  }

  getRun(id: string): Run | undefined {
    const row = this.database.prepare("SELECT * FROM runs WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          conversationId: String(row.conversation_id),
          admissionSeq: Number(row.admission_seq),
          request: decode(row.request_json),
          fingerprint: String(row.fingerprint),
          status: row.status as RunStatus,
          dshSessionRef: String(row.dsh_session_ref),
        };
  }

  private insertEvent(
    runId: string,
    channel: EventChannel,
    type: string,
    payload: unknown,
  ): number {
    const row = this.database
      .prepare("UPDATE runs SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq AS seq")
      .get(runId) as { seq: number } | undefined;
    if (row === undefined) throw new Error("run not found");
    this.database
      .prepare(
        "INSERT INTO run_events(run_id,seq,channel,type,payload_json,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run(runId, row.seq, channel, type, encode(payload), Date.now());
    return row.seq;
  }

  appendEvent(runId: string, channel: EventChannel, type: string, payload: unknown): number {
    return this.transaction(() => this.insertEvent(runId, channel, type, payload));
  }

  listEvents(runId: string, after: number, limit: number): RunEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1)
      throw new Error("invalid cursor page");
    return (
      this.database
        .prepare("SELECT * FROM run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?")
        .all(runId, after, limit) as Record<string, unknown>[]
    ).map((row) => ({
      runId: String(row.run_id),
      seq: Number(row.seq),
      channel: row.channel as EventChannel,
      type: String(row.type),
      payload: decode(row.payload_json),
      createdAt: Number(row.created_at),
    }));
  }

  getEventHighWater(runId: string): number {
    const row = this.database.prepare("SELECT next_seq FROM runs WHERE id=?").get(runId) as
      | { next_seq: number }
      | undefined;
    if (row === undefined) throw new Error("run not found");
    return Number(row.next_seq);
  }

  listEventsThrough(runId: string, after: number, limit: number, through: number): RunEvent[] {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      !Number.isSafeInteger(through) ||
      through < after
    )
      throw new Error("invalid bounded cursor page");
    return (
      this.database
        .prepare(
          "SELECT * FROM run_events WHERE run_id=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?",
        )
        .all(runId, after, through, limit) as Record<string, unknown>[]
    ).map((row) => ({
      runId: String(row.run_id),
      seq: Number(row.seq),
      channel: row.channel as EventChannel,
      type: String(row.type),
      payload: decode(row.payload_json),
      createdAt: Number(row.created_at),
    }));
  }

  startRun(runId: string): void {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (run === undefined) throw new Error("run not found");
      const result = this.database
        .prepare("UPDATE runs SET status='running',updated_at=? WHERE id=? AND status='queued'")
        .run(Date.now(), runId);
      if (Number(result.changes) !== 1) throw new Error("run is not queued");
      this.insertEvent(runId, "business", "running", { status: "running" });
      const event = RunStartedEventSchema.parse({
        type: EventType.RUN_STARTED,
        threadId: run.conversationId,
        runId,
      });
      this.insertEvent(runId, "ag-ui", "RUN_STARTED", event);
    });
  }

  finishRun(
    runId: string,
    status: "succeeded" | "failed",
    diagnostics?: { code?: string; message?: string },
  ): void {
    this.transaction(() => {
      const run = this.getRun(runId);
      if (run === undefined) throw new Error("run not found");
      const result = this.database
        .prepare(`UPDATE runs SET status=?,terminal_code=?,terminal_message=?,updated_at=?
        WHERE id=? AND status='running'`)
        .run(status, diagnostics?.code ?? null, diagnostics?.message ?? null, Date.now(), runId);
      if (Number(result.changes) !== 1) throw new Error("run is not running");
      this.insertEvent(runId, "business", status, {
        status,
        ...(diagnostics?.code === undefined ? {} : { code: diagnostics.code }),
        ...(diagnostics?.message === undefined ? {} : { message: diagnostics.message }),
      });
      const terminal =
        status === "succeeded"
          ? RunFinishedEventSchema.parse({
              type: EventType.RUN_FINISHED,
              threadId: run.conversationId,
              runId,
              outcome: { type: "success" },
            })
          : RunErrorEventSchema.parse({
              type: EventType.RUN_ERROR,
              message: diagnostics?.message ?? "Run failed",
              ...(diagnostics?.code === undefined ? {} : { code: diagnostics.code }),
            });
      this.insertEvent(runId, "ag-ui", terminal.type, terminal);
    });
  }

  private markExecutionUnknownInside(runId: string): void {
    const run = this.getRun(runId);
    if (run === undefined) throw new Error("run not found");
    const changed = this.database
      .prepare(`UPDATE runs SET status='execution_unknown',terminal_code='EXECUTION_UNKNOWN',
      terminal_message='Runtime exited while execution outcome was unknown',updated_at=?
      WHERE id=? AND status='running'`)
      .run(Date.now(), runId);
    if (Number(changed.changes) !== 1) throw new Error("run is not running");
    this.database
      .prepare("UPDATE conversations SET recovery_state='blocked',updated_at=? WHERE id=?")
      .run(Date.now(), run.conversationId);
    this.insertEvent(runId, "business", "execution_unknown", { code: "EXECUTION_UNKNOWN" });
    const event = RunErrorEventSchema.parse({
      type: EventType.RUN_ERROR,
      code: "EXECUTION_UNKNOWN",
      message: "Runtime exited while execution outcome was unknown",
    });
    this.insertEvent(runId, "ag-ui", "RUN_ERROR", event);
  }

  markExecutionUnknown(runId: string): void {
    this.transaction(() => this.markExecutionUnknownInside(runId));
  }

  recoverStartup(): Array<{ runId: string; request: Json }> {
    return this.transaction(() => {
      const running = this.database
        .prepare("SELECT id FROM runs WHERE status='running'")
        .all() as Array<{
        id: string;
      }>;
      for (const row of running) this.markExecutionUnknownInside(row.id);
      const queued = this.database
        .prepare(`SELECT r.id,r.request_json FROM runs r
        JOIN conversations c ON c.id=r.conversation_id
        WHERE r.status='queued' AND c.recovery_state='active' ORDER BY r.created_at,r.id`)
        .all() as Array<{ id: string; request_json: string }>;
      return queued.map((row) => ({ runId: row.id, request: decode(row.request_json) }));
    });
  }

  acknowledgeUnknown(conversationId: string, newSessionRef: string): Conversation {
    return this.transaction(() => {
      const conversation = this.getConversation(conversationId);
      if (conversation?.recoveryState !== "blocked") throw new Error("conversation is not blocked");
      if (newSessionRef.trim() === "" || newSessionRef === conversation.dshSessionRef)
        throw new Error("new session reference is required");
      const nextGeneration = conversation.sessionGeneration + 1;
      this.database
        .prepare("INSERT INTO session_refs(ref,conversation_id,generation) VALUES(?,?,?)")
        .run(newSessionRef, conversationId, nextGeneration);
      const now = Date.now();
      const result = this.database
        .prepare(`UPDATE conversations SET recovery_state='active',session_generation=session_generation+1,
        dsh_session_ref=?,recovery_acknowledged_at=?,updated_at=? WHERE id=? AND recovery_state='blocked' AND session_generation=?`)
        .run(newSessionRef, now, now, conversationId, conversation.sessionGeneration);
      if (Number(result.changes) !== 1) throw new Error("conversation acknowledgement conflict");
      const seqRow = this.database
        .prepare(
          "SELECT COALESCE(MAX(seq),0)+1 AS seq FROM conversation_events WHERE conversation_id=?",
        )
        .get(conversationId) as { seq: number };
      this.database
        .prepare(
          "INSERT INTO conversation_events(conversation_id,seq,type,payload_json,created_at) VALUES(?,?,?,?,?)",
        )
        .run(
          conversationId,
          seqRow.seq,
          "execution_unknown_acknowledged",
          encode({
            previousSessionRef: conversation.dshSessionRef,
            newSessionRef,
            generation: nextGeneration,
          }),
          now,
        );
      return this.getConversation(conversationId)!;
    });
  }

  listConversationEvents(
    conversationId: string,
  ): Array<{ seq: number; type: string; payload: Json; createdAt: number }> {
    return (
      this.database
        .prepare(
          "SELECT seq,type,payload_json,created_at FROM conversation_events WHERE conversation_id=? ORDER BY seq",
        )
        .all(conversationId) as Array<Record<string, unknown>>
    ).map((row) => ({
      seq: Number(row.seq),
      type: String(row.type),
      payload: decode(row.payload_json),
      createdAt: Number(row.created_at),
    }));
  }

  saveArtifact(input: {
    id: string;
    runId: string;
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  }): {
    id: string;
    size: number;
    sha256: string;
  } {
    if (
      input.filename !== basename(input.filename) ||
      input.filename === "." ||
      input.filename === ".."
    )
      throw new Error("unsafe filename");
    const bytes = Buffer.from(input.bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.database
      .prepare(
        "INSERT INTO artifacts(id,run_id,filename,media_type,bytes,size,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        input.id,
        input.runId,
        input.filename,
        input.mediaType,
        bytes,
        bytes.byteLength,
        sha256,
        Date.now(),
      );
    return { id: input.id, size: bytes.byteLength, sha256 };
  }

  getArtifact(id: string):
    | {
        id: string;
        filename: string;
        mediaType: string;
        size: number;
        sha256: string;
        bytes: Buffer;
      }
    | undefined {
    const row = this.database.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row.id),
          filename: String(row.filename),
          mediaType: String(row.media_type),
          size: Number(row.size),
          sha256: String(row.sha256),
          bytes: Buffer.from(row.bytes as Uint8Array),
        };
  }

  close(): void {
    if (this.database.isOpen) this.database.close();
  }
}
