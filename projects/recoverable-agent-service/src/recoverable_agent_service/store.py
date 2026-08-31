"""SQLite migrations and authoritative business-state repository."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .domain import (
    Artifact,
    ArtifactUpdate,
    ConflictError,
    Conversation,
    DatabaseConfigurationError,
    FutureSchemaVersionError,
    InvalidInputError,
    InvalidTransitionError,
    NotFoundError,
    Run,
    RunEvent,
    RunSubmission,
    build_runtime_input,
    canonical_json,
    normalize_artifact_names,
    normalize_idempotency_key,
    request_fingerprint,
    validate_prompt,
)

SCHEMA_VERSION = 1
BUSY_TIMEOUT_MS = 5_000
MAX_ARTIFACT_BYTES = 1024 * 1024
DEFAULT_MEDIA_TYPE = "application/octet-stream"
REPOSITORY_EVENT_TYPES = frozenset({"run.queued", "run.started", "run.succeeded", "run.failed"})
IDEMPOTENCY_UNIQUE_ERROR = "UNIQUE constraint failed: runs.conversation_id, runs.idempotency_key"
NONTERMINAL_UNIQUE_ERROR = "UNIQUE constraint failed: runs.conversation_id"

MIGRATION_V1 = (
    """
    CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        dsh_session_id TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK(state IN ('active', 'attention_required')),
        title TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        dsh_session_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        user_prompt TEXT NOT NULL,
        runtime_input TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'succeeded', 'failed')),
        last_event_seq INTEGER NOT NULL DEFAULT 0 CHECK(last_event_seq >= 0),
        final_response TEXT,
        finish_reason TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        UNIQUE(conversation_id, idempotency_key),
        CHECK(
            (state = 'queued' AND started_at IS NULL AND finished_at IS NULL
                AND final_response IS NULL AND finish_reason IS NULL
                AND error_code IS NULL AND error_message IS NULL)
            OR
            (state = 'running' AND started_at IS NOT NULL AND finished_at IS NULL
                AND final_response IS NULL AND finish_reason IS NULL
                AND error_code IS NULL AND error_message IS NULL)
            OR
            (state = 'succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL
                AND finish_reason IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
            OR
            (state = 'failed' AND started_at IS NOT NULL AND finished_at IS NOT NULL
                AND final_response IS NULL AND finish_reason IS NULL
                AND error_code IS NOT NULL AND error_message IS NOT NULL)
        )
    )
    """,
    """
    CREATE UNIQUE INDEX one_nonterminal_run_per_conversation
    ON runs(conversation_id)
    WHERE state IN ('queued', 'running')
    """,
    """
    CREATE INDEX runs_by_conversation_time
    ON runs(conversation_id, created_at)
    """,
    """
    CREATE INDEX runs_by_state_time
    ON runs(state, created_at)
    """,
    """
    CREATE TABLE run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL CHECK(seq > 0),
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, seq)
    )
    """,
    """
    CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        requested_name TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'available', 'missing', 'invalid')),
        content BLOB,
        sha256 TEXT,
        byte_size INTEGER,
        media_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, relative_path),
        CHECK(length(requested_name) BETWEEN 1 AND 128),
        CHECK(
            (state = 'available' AND content IS NOT NULL AND sha256 IS NOT NULL
                AND length(sha256) = 64 AND byte_size IS NOT NULL
                AND byte_size >= 0 AND byte_size = length(content))
            OR
            (state != 'available' AND content IS NULL AND sha256 IS NULL AND byte_size IS NULL)
        )
    )
    """,
    """
    CREATE INDEX artifacts_by_run
    ON artifacts(run_id)
    """,
    """
    CREATE TRIGGER artifacts_are_immutable_after_availability
    BEFORE UPDATE OF state, content, sha256, byte_size, media_type ON artifacts
    WHEN OLD.state = 'available'
    BEGIN
        SELECT RAISE(ABORT, 'available artifact is immutable');
    END
    """,
)


def utc_timestamp() -> str:
    """Return a fixed-width UTC timestamp whose text order is chronological."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def new_id() -> str:
    """Return an opaque durable identifier."""
    return str(uuid.uuid4())


class SQLiteStore:
    """Repository that opens one configured SQLite connection per operation."""

    def __init__(self, database_path: str | Path) -> None:
        self.database_path = Path(database_path)

    def health_check(self) -> bool:
        """Return whether the configured database has the current readable schema."""
        try:
            with self._connection() as connection:
                row = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
        except sqlite3.Error:
            return False
        return row is not None and row[0] == SCHEMA_VERSION

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(
            self.database_path,
            timeout=BUSY_TIMEOUT_MS / 1000,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute(f"PRAGMA busy_timeout={BUSY_TIMEOUT_MS}")
        try:
            yield connection
        finally:
            connection.close()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                yield connection
            except BaseException:
                connection.rollback()
                raise
            else:
                connection.commit()

    def migrate(self) -> None:
        """Apply the v1 schema atomically after enabling WAL."""
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            journal_mode_row = connection.execute("PRAGMA journal_mode=WAL").fetchone()
            journal_mode = str(journal_mode_row[0]).lower() if journal_mode_row else ""
            if journal_mode != "wal":
                raise DatabaseConfigurationError(
                    f"SQLite WAL mode is required, but journal_mode returned {journal_mode!r}"
                )
            connection.execute("BEGIN IMMEDIATE")
            try:
                connection.execute(
                    """
                    CREATE TABLE IF NOT EXISTS schema_migrations (
                        version INTEGER PRIMARY KEY,
                        applied_at TEXT NOT NULL
                    )
                    """
                )
                row = connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()
                current_version = row[0] if row and row[0] is not None else 0
                if current_version > SCHEMA_VERSION:
                    raise FutureSchemaVersionError(
                        f"database schema version {current_version} is newer than {SCHEMA_VERSION}"
                    )
                if current_version < SCHEMA_VERSION:
                    for statement in MIGRATION_V1:
                        connection.execute(statement)
                    connection.execute(
                        "INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)",
                        (SCHEMA_VERSION, utc_timestamp()),
                    )
            except BaseException:
                connection.rollback()
                raise
            else:
                connection.commit()

    def create_conversation(self, title: str | None = None) -> Conversation:
        """Create an active Conversation with a fresh DSH session reference."""
        conversation_id = new_id()
        dsh_session_id = new_id()
        timestamp = utc_timestamp()
        with self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO conversations(
                    id, dsh_session_id, state, title, created_at, updated_at
                ) VALUES(?, ?, 'active', ?, ?, ?)
                """,
                (conversation_id, dsh_session_id, title, timestamp, timestamp),
            )
            row = self._require_row(
                connection.execute(
                    "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
                ).fetchone(),
                "conversation",
                conversation_id,
            )
        return self._conversation_from_row(row)

    def get_conversation(self, conversation_id: str) -> Conversation:
        """Load one Conversation by id."""
        with self._connection() as connection:
            row = self._require_row(
                connection.execute(
                    "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
                ).fetchone(),
                "conversation",
                conversation_id,
            )
        return self._conversation_from_row(row)

    def get_run(self, run_id: str) -> Run:
        """Load one Run by id."""
        with self._connection() as connection:
            row = self._require_row(
                connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone(),
                "run",
                run_id,
            )
        return self._run_from_row(row)

    def list_runs(self, conversation_id: str) -> list[Run]:
        """List a Conversation's Runs in durable creation order."""
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM runs
                WHERE conversation_id = ?
                ORDER BY created_at, rowid
                """,
                (conversation_id,),
            ).fetchall()
        return [self._run_from_row(row) for row in rows]

    def list_queued_runs(self) -> list[Run]:
        """List durable queued Runs whose Conversations remain active."""
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT r.* FROM runs AS r
                JOIN conversations AS c ON c.id = r.conversation_id
                WHERE r.state = 'queued' AND c.state = 'active'
                ORDER BY r.created_at, r.rowid
                """
            ).fetchall()
        return [self._run_from_row(row) for row in rows]

    def list_running_runs(self) -> list[Run]:
        """List Runs that require conservative startup recovery."""
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT * FROM runs WHERE state = 'running' ORDER BY created_at, rowid"
            ).fetchall()
        return [self._run_from_row(row) for row in rows]

    def submit_run(
        self,
        conversation_id: str,
        idempotency_key: object,
        prompt: object,
        artifact_names: Sequence[str],
    ) -> RunSubmission:
        """Create a queued Run or return an exact idempotent replay."""
        normalized_key = normalize_idempotency_key(idempotency_key)
        exact_prompt = validate_prompt(prompt)
        normalized_names = normalize_artifact_names(artifact_names)
        fingerprint = request_fingerprint(exact_prompt, normalized_names)

        try:
            with self._transaction() as connection:
                existing = connection.execute(
                    """
                    SELECT * FROM runs
                    WHERE conversation_id = ? AND idempotency_key = ?
                    """,
                    (conversation_id, normalized_key),
                ).fetchone()
                if existing is not None:
                    return self._resolve_replay(existing, fingerprint)

                conversation = self._require_row(
                    connection.execute(
                        "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
                    ).fetchone(),
                    "conversation",
                    conversation_id,
                )
                if conversation["state"] != "active":
                    raise ConflictError("conversation requires recovery acknowledgement")
                nonterminal = connection.execute(
                    """
                    SELECT id FROM runs
                    WHERE conversation_id = ? AND state IN ('queued', 'running')
                    """,
                    (conversation_id,),
                ).fetchone()
                if nonterminal is not None:
                    raise ConflictError("conversation already has a nonterminal run")

                run_id = new_id()
                timestamp = utc_timestamp()
                runtime_input = build_runtime_input(run_id, exact_prompt, normalized_names)
                connection.execute(
                    """
                    INSERT INTO runs(
                        id, conversation_id, dsh_session_id, idempotency_key,
                        request_fingerprint, user_prompt, runtime_input, state,
                        last_event_seq, created_at
                    ) VALUES(?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)
                    """,
                    (
                        run_id,
                        conversation_id,
                        conversation["dsh_session_id"],
                        normalized_key,
                        fingerprint,
                        exact_prompt,
                        runtime_input,
                        timestamp,
                    ),
                )
                queued_artifacts: list[dict[str, str]] = []
                for name in normalized_names:
                    artifact_id = new_id()
                    relative_path = f"artifacts/{run_id}/{name}"
                    connection.execute(
                        """
                        INSERT INTO artifacts(
                            id, run_id, requested_name, relative_path, state,
                            media_type, created_at
                        ) VALUES(?, ?, ?, ?, 'pending', ?, ?)
                        """,
                        (
                            artifact_id,
                            run_id,
                            name,
                            relative_path,
                            DEFAULT_MEDIA_TYPE,
                            timestamp,
                        ),
                    )
                    queued_artifacts.append(
                        {"id": artifact_id, "name": name, "relative_path": relative_path}
                    )
                self._append_event(
                    connection,
                    run_id,
                    "run.queued",
                    {"artifacts": queued_artifacts},
                    timestamp,
                )
                row = self._require_row(
                    connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone(),
                    "run",
                    run_id,
                )
            return RunSubmission(run=self._run_from_row(row), created=True)
        except sqlite3.IntegrityError as error:
            message = str(error)
            if message not in {IDEMPOTENCY_UNIQUE_ERROR, NONTERMINAL_UNIQUE_ERROR}:
                raise
            replay = self._replay_after_collision(conversation_id, normalized_key, fingerprint)
            if replay is not None:
                return replay
            if message == NONTERMINAL_UNIQUE_ERROR and self._has_nonterminal_run(conversation_id):
                raise ConflictError("conversation already has a nonterminal run") from error
            raise

    def append_event(self, run_id: str, event_type: str, data: dict[str, Any]) -> RunEvent:
        """Append a projected runtime event to a running Run."""
        if event_type in REPOSITORY_EVENT_TYPES:
            raise InvalidInputError(f"repository owns lifecycle event type: {event_type}")
        with self._transaction() as connection:
            run = self._require_row(
                connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone(),
                "run",
                run_id,
            )
            if run["state"] != "running":
                raise InvalidTransitionError("only running runs can receive projected events")
            event = self._append_event(connection, run_id, event_type, data, utc_timestamp())
        return event

    def list_events(self, run_id: str, after_seq: int = 0) -> list[RunEvent]:
        """List persisted Run events after a sequence cursor."""
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM run_events
                WHERE run_id = ? AND seq > ?
                ORDER BY seq
                """,
                (run_id, after_seq),
            ).fetchall()
        return [self._event_from_row(row) for row in rows]

    def list_artifacts(self, run_id: str) -> list[Artifact]:
        """List artifact metadata, including immutable content only when available."""
        with self._connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM artifacts
                WHERE run_id = ?
                ORDER BY requested_name
                """,
                (run_id,),
            ).fetchall()
        return [self._artifact_from_row(row) for row in rows]

    def get_available_artifact(self, run_id: str, artifact_id: str) -> Artifact:
        """Return an immutable available artifact or hide unavailable content."""
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM artifacts
                WHERE run_id = ? AND id = ? AND state = 'available'
                """,
                (run_id, artifact_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"available artifact not found: {artifact_id}")
        return self._artifact_from_row(row)

    def claim_oldest_run(self) -> Run | None:
        """Conditionally claim the oldest queued Run on an active Conversation."""
        with self._transaction() as connection:
            candidate = connection.execute(
                """
                SELECT r.id FROM runs AS r
                JOIN conversations AS c ON c.id = r.conversation_id
                WHERE r.state = 'queued' AND c.state = 'active'
                ORDER BY r.created_at, r.rowid
                LIMIT 1
                """
            ).fetchone()
            if candidate is None:
                return None
            timestamp = utc_timestamp()
            updated = connection.execute(
                """
                UPDATE runs
                SET state = 'running', started_at = ?
                WHERE id = ? AND state = 'queued'
                """,
                (timestamp, candidate["id"]),
            )
            if updated.rowcount != 1:
                return None
            self._append_event(connection, candidate["id"], "run.started", {}, timestamp)
            row = self._require_row(
                connection.execute(
                    "SELECT * FROM runs WHERE id = ?", (candidate["id"],)
                ).fetchone(),
                "run",
                candidate["id"],
            )
        return self._run_from_row(row)

    def complete_run_success(
        self,
        run_id: str,
        *,
        final_response: str,
        finish_reason: str,
        artifacts: Sequence[ArtifactUpdate],
    ) -> Run:
        """Store artifact outcomes and Run success in one transaction."""
        if finish_reason != "completed":
            raise InvalidInputError("only the completed finish reason can succeed")
        prepared = self._prepare_artifact_updates(artifacts)
        with self._transaction() as connection:
            self._require_running_run(connection, run_id)
            existing_rows = connection.execute(
                "SELECT * FROM artifacts WHERE run_id = ? ORDER BY requested_name", (run_id,)
            ).fetchall()
            expected_names = {row["requested_name"] for row in existing_rows}
            if set(prepared) != expected_names:
                raise InvalidInputError("artifact outcomes must cover every requested artifact")
            timestamp = utc_timestamp()
            for row in existing_rows:
                state, content, digest, byte_size, media_type = prepared[row["requested_name"]]
                connection.execute(
                    """
                    UPDATE artifacts
                    SET state = ?, content = ?, sha256 = ?, byte_size = ?, media_type = ?
                    WHERE id = ? AND state = 'pending'
                    """,
                    (state, content, digest, byte_size, media_type or row["media_type"], row["id"]),
                )
            updated = connection.execute(
                """
                UPDATE runs
                SET state = 'succeeded', final_response = ?, finish_reason = ?, finished_at = ?
                WHERE id = ? AND state = 'running'
                """,
                (final_response, finish_reason, timestamp, run_id),
            )
            if updated.rowcount != 1:
                raise InvalidTransitionError("run is no longer running")
            self._append_event(
                connection,
                run_id,
                "run.succeeded",
                {"finish_reason": finish_reason},
                timestamp,
            )
            row = self._require_row(
                connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone(),
                "run",
                run_id,
            )
        return self._run_from_row(row)

    def fail_run(
        self,
        run_id: str,
        *,
        error_code: str,
        error_message: str,
        uncertain: bool,
    ) -> Run:
        """Fail a running Run and optionally require Conversation recovery."""
        with self._transaction() as connection:
            run = self._require_running_run(connection, run_id)
            timestamp = utc_timestamp()
            connection.execute(
                """
                UPDATE runs
                SET state = 'failed', error_code = ?, error_message = ?, finished_at = ?
                WHERE id = ? AND state = 'running'
                """,
                (error_code, error_message, timestamp, run_id),
            )
            connection.execute(
                """
                UPDATE artifacts
                SET state = 'invalid'
                WHERE run_id = ? AND state = 'pending'
                """,
                (run_id,),
            )
            if uncertain:
                connection.execute(
                    """
                    UPDATE conversations
                    SET state = 'attention_required', updated_at = ?
                    WHERE id = ?
                    """,
                    (timestamp, run["conversation_id"]),
                )
            self._append_event(
                connection,
                run_id,
                "run.failed",
                {"error_code": error_code, "error_message": error_message, "uncertain": uncertain},
                timestamp,
            )
            row = self._require_row(
                connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone(),
                "run",
                run_id,
            )
        return self._run_from_row(row)

    def recover_running_runs(self) -> int:
        """Conservatively fail legacy running Runs without touching queued work."""
        with self._transaction() as connection:
            rows = connection.execute(
                "SELECT * FROM runs WHERE state = 'running' ORDER BY created_at, rowid"
            ).fetchall()
            for run in rows:
                timestamp = utc_timestamp()
                connection.execute(
                    """
                    UPDATE runs
                    SET state = 'failed', error_code = 'execution_uncertain',
                        error_message = 'service restarted during execution', finished_at = ?
                    WHERE id = ? AND state = 'running'
                    """,
                    (timestamp, run["id"]),
                )
                connection.execute(
                    """
                    UPDATE conversations
                    SET state = 'attention_required', updated_at = ?
                    WHERE id = ?
                    """,
                    (timestamp, run["conversation_id"]),
                )
                connection.execute(
                    """
                    UPDATE artifacts
                    SET state = 'invalid'
                    WHERE run_id = ? AND state = 'pending'
                    """,
                    (run["id"],),
                )
                self._append_event(
                    connection,
                    run["id"],
                    "run.failed",
                    {
                        "error_code": "execution_uncertain",
                        "error_message": "service restarted during execution",
                        "uncertain": True,
                    },
                    timestamp,
                )
        return len(rows)

    def acknowledge_recovery(self, conversation_id: str) -> Conversation:
        """Reactivate a Conversation with a fresh DSH session, idempotently."""
        with self._transaction() as connection:
            row = self._require_row(
                connection.execute(
                    "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
                ).fetchone(),
                "conversation",
                conversation_id,
            )
            if row["state"] == "active":
                return self._conversation_from_row(row)
            connection.execute(
                """
                UPDATE conversations
                SET state = 'active', dsh_session_id = ?, updated_at = ?
                WHERE id = ? AND state = 'attention_required'
                """,
                (new_id(), utc_timestamp(), conversation_id),
            )
            updated = self._require_row(
                connection.execute(
                    "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
                ).fetchone(),
                "conversation",
                conversation_id,
            )
        return self._conversation_from_row(updated)

    def _replay_after_collision(
        self, conversation_id: str, key: str, fingerprint: str
    ) -> RunSubmission | None:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT * FROM runs
                WHERE conversation_id = ? AND idempotency_key = ?
                """,
                (conversation_id, key),
            ).fetchone()
        if row is None:
            return None
        return self._resolve_replay(row, fingerprint)

    def _has_nonterminal_run(self, conversation_id: str) -> bool:
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT id FROM runs
                WHERE conversation_id = ? AND state IN ('queued', 'running')
                """,
                (conversation_id,),
            ).fetchone()
        return row is not None

    @staticmethod
    def _resolve_replay(row: sqlite3.Row, fingerprint: str) -> RunSubmission:
        if row["request_fingerprint"] != fingerprint:
            raise ConflictError("idempotency key was already used for a different request")
        return RunSubmission(run=SQLiteStore._run_from_row(row), created=False)

    @staticmethod
    def _prepare_artifact_updates(
        updates: Sequence[ArtifactUpdate],
    ) -> dict[str, tuple[str, bytes | None, str | None, int | None, str | None]]:
        prepared: dict[str, tuple[str, bytes | None, str | None, int | None, str | None]] = {}
        for update in updates:
            (name,) = normalize_artifact_names([update.requested_name])
            if name in prepared:
                raise InvalidInputError("artifact outcomes must be unique")
            if update.state not in {"available", "missing", "invalid"}:
                raise InvalidInputError(f"invalid artifact outcome: {update.state}")
            if update.state == "available":
                if update.content is None:
                    raise InvalidInputError("available artifact content is required")
                content = bytes(update.content)
                if len(content) > MAX_ARTIFACT_BYTES:
                    raise InvalidInputError("artifact content exceeds 1 MiB")
                prepared[name] = (
                    update.state,
                    content,
                    hashlib.sha256(content).hexdigest(),
                    len(content),
                    update.media_type,
                )
            else:
                if update.content is not None:
                    raise InvalidInputError("unavailable artifacts cannot store content")
                prepared[name] = (update.state, None, None, None, update.media_type)
        return prepared

    @staticmethod
    def _append_event(
        connection: sqlite3.Connection,
        run_id: str,
        event_type: str,
        data: dict[str, Any],
        timestamp: str,
    ) -> RunEvent:
        row = SQLiteStore._require_row(
            connection.execute(
                "SELECT last_event_seq FROM runs WHERE id = ?", (run_id,)
            ).fetchone(),
            "run",
            run_id,
        )
        previous_seq = row["last_event_seq"]
        seq = previous_seq + 1
        updated = connection.execute(
            """
            UPDATE runs SET last_event_seq = ?
            WHERE id = ? AND last_event_seq = ?
            """,
            (seq, run_id, previous_seq),
        )
        if updated.rowcount != 1:
            raise ConflictError("run event sequence changed concurrently")
        data_json = canonical_json(data)
        connection.execute(
            """
            INSERT INTO run_events(run_id, seq, type, data_json, created_at)
            VALUES(?, ?, ?, ?, ?)
            """,
            (run_id, seq, event_type, data_json, timestamp),
        )
        return RunEvent(run_id=run_id, seq=seq, type=event_type, data=data, created_at=timestamp)

    @staticmethod
    def _require_running_run(connection: sqlite3.Connection, run_id: str) -> sqlite3.Row:
        row = SQLiteStore._require_row(
            connection.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone(),
            "run",
            run_id,
        )
        if row["state"] != "running":
            raise InvalidTransitionError(f"run is not running: {run_id}")
        return row

    @staticmethod
    def _require_row(row: sqlite3.Row | None, kind: str, record_id: str) -> sqlite3.Row:
        if row is None:
            raise NotFoundError(f"{kind} not found: {record_id}")
        return row

    @staticmethod
    def _conversation_from_row(row: sqlite3.Row) -> Conversation:
        return Conversation(
            id=row["id"],
            dsh_session_id=row["dsh_session_id"],
            state=row["state"],
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _run_from_row(row: sqlite3.Row) -> Run:
        return Run(
            id=row["id"],
            conversation_id=row["conversation_id"],
            dsh_session_id=row["dsh_session_id"],
            idempotency_key=row["idempotency_key"],
            request_fingerprint=row["request_fingerprint"],
            user_prompt=row["user_prompt"],
            runtime_input=row["runtime_input"],
            state=row["state"],
            last_event_seq=row["last_event_seq"],
            final_response=row["final_response"],
            finish_reason=row["finish_reason"],
            error_code=row["error_code"],
            error_message=row["error_message"],
            created_at=row["created_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
        )

    @staticmethod
    def _event_from_row(row: sqlite3.Row) -> RunEvent:
        return RunEvent(
            run_id=row["run_id"],
            seq=row["seq"],
            type=row["type"],
            data=json.loads(row["data_json"]),
            created_at=row["created_at"],
        )

    @staticmethod
    def _artifact_from_row(row: sqlite3.Row) -> Artifact:
        content = row["content"]
        return Artifact(
            id=row["id"],
            run_id=row["run_id"],
            requested_name=row["requested_name"],
            relative_path=row["relative_path"],
            state=row["state"],
            content=bytes(content) if content is not None else None,
            sha256=row["sha256"],
            byte_size=row["byte_size"],
            media_type=row["media_type"],
            created_at=row["created_at"],
        )
