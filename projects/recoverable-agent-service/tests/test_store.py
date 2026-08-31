from __future__ import annotations

import importlib
import re
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

TIMESTAMP_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\Z")
LIFECYCLE_EVENT_TYPES = ("run.queued", "run.started", "run.succeeded", "run.failed")


def load_store_module():
    try:
        return importlib.import_module("recoverable_agent_service.store")
    except ImportError as error:
        pytest.fail(f"Task 1A SQLite store is not implemented: {error}")


def make_store(database_path: Path):
    module = load_store_module()
    repository = module.SQLiteStore(database_path)
    repository.migrate()
    return repository, module


def test_health_check_reports_only_a_migrated_readable_database(tmp_path: Path) -> None:
    module = load_store_module()
    repository = module.SQLiteStore(tmp_path / "health.db")

    assert repository.health_check() is False
    repository.migrate()
    assert repository.health_check() is True


def install_failing_event_trigger(repository, event_type: str) -> None:
    trigger_name = f"fail_{event_type.replace('.', '_')}"
    with sqlite3.connect(repository.database_path) as connection:
        connection.execute(
            f"""
            CREATE TRIGGER {trigger_name}
            BEFORE INSERT ON run_events
            WHEN NEW.type = '{event_type}'
            BEGIN
                SELECT RAISE(ABORT, 'injected run event failure');
            END
            """
        )


def test_empty_database_migrates_once_and_repeat_migration_is_idempotent(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "service.db")

    repository.migrate()

    with sqlite3.connect(repository.database_path) as connection:
        assert connection.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert connection.execute("SELECT version FROM schema_migrations").fetchall() == [(1,)]
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
    assert {"conversations", "runs", "run_events", "artifacts"} <= tables


def test_future_schema_version_is_rejected_without_modifying_it(tmp_path: Path) -> None:
    module = load_store_module()
    database_path = tmp_path / "future.db"
    with sqlite3.connect(database_path) as connection:
        connection.execute(
            "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
        )
        connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES(2, 'future')")

    with pytest.raises(module.FutureSchemaVersionError):
        module.SQLiteStore(database_path).migrate()

    with sqlite3.connect(database_path) as connection:
        assert connection.execute(
            "SELECT version, applied_at FROM schema_migrations"
        ).fetchall() == [(2, "future")]


def test_each_repository_operation_uses_a_fresh_configured_connection(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_store_module()
    real_connect = sqlite3.connect
    observations: list[tuple[sqlite3.Connection, int, int]] = []

    class RecordingConnection(sqlite3.Connection):
        def close(self) -> None:
            observations.append(
                (
                    self,
                    self.execute("PRAGMA foreign_keys").fetchone()[0],
                    self.execute("PRAGMA busy_timeout").fetchone()[0],
                )
            )
            super().close()

    def recording_connect(*args, **kwargs):
        kwargs["factory"] = RecordingConnection
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(module.sqlite3, "connect", recording_connect)
    repository = module.SQLiteStore(tmp_path / "connections.db")
    repository.migrate()
    conversation = repository.create_conversation()
    repository.get_conversation(conversation.id)

    assert len(observations) == 3
    assert len({id(connection) for connection, _, _ in observations}) == 3
    assert all(foreign_keys == 1 for _, foreign_keys, _ in observations)
    assert all(busy_timeout == 5_000 for _, _, busy_timeout in observations)


def test_migration_rejects_a_database_that_cannot_enter_wal_mode(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    module = load_store_module()
    real_connect = sqlite3.connect

    class NonWalCursor:
        @staticmethod
        def fetchone():
            return ("delete",)

    class NonWalConnection(sqlite3.Connection):
        def execute(self, sql, parameters=(), /):
            if " ".join(sql.split()).upper() == "PRAGMA JOURNAL_MODE=WAL":
                return NonWalCursor()
            return super().execute(sql, parameters)

    def non_wal_connect(*args, **kwargs):
        kwargs["factory"] = NonWalConnection
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(module.sqlite3, "connect", non_wal_connect)

    with pytest.raises(module.DatabaseConfigurationError, match="WAL"):
        module.SQLiteStore(tmp_path / "non-wal.db").migrate()


def test_schema_checks_states_and_enforces_foreign_keys(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "constraints.db")
    timestamp = "2026-08-31T00:00:00.000000Z"

    with sqlite3.connect(repository.database_path) as connection:
        connection.execute("PRAGMA foreign_keys=ON")
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO conversations(id, dsh_session_id, state, created_at, updated_at)
                VALUES('bad', 'session', 'unknown', ?, ?)
                """,
                (timestamp, timestamp),
            )
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute(
                """
                INSERT INTO artifacts(
                    id, run_id, requested_name, relative_path, state, media_type, created_at
                ) VALUES('artifact', 'missing-run', 'proof.txt',
                    'artifacts/missing-run/proof.txt', 'pending',
                    'application/octet-stream', ?)
                """,
                (timestamp,),
            )


def test_schema_rejects_incoherent_run_and_artifact_rows(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "coherence.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", ["proof.txt"]).run

    statements = [
        ("UPDATE runs SET state = 'running' WHERE id = ?", (run.id,)),
        ("UPDATE runs SET last_event_seq = -1 WHERE id = ?", (run.id,)),
        (
            "UPDATE artifacts SET state = 'available' WHERE run_id = ?",
            (run.id,),
        ),
        (
            "UPDATE artifacts SET content = X'00' WHERE run_id = ?",
            (run.id,),
        ),
    ]
    with sqlite3.connect(repository.database_path) as connection:
        for sql, parameters in statements:
            with pytest.raises(sqlite3.IntegrityError):
                connection.execute(sql, parameters)
            connection.rollback()


def test_conversation_creation_persists_a_stable_session_reference(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "conversation.db")

    created = repository.create_conversation(title="Evidence run")
    loaded = repository.get_conversation(created.id)

    assert loaded == created
    assert loaded.state == "active"
    assert loaded.title == "Evidence run"
    assert loaded.id != loaded.dsh_session_id
    assert TIMESTAMP_PATTERN.fullmatch(loaded.created_at)
    assert loaded.created_at == loaded.updated_at


def test_submit_run_is_idempotent_and_uses_canonical_artifact_order(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "idempotency.db")
    conversation = repository.create_conversation()

    first = repository.submit_run(
        conversation.id,
        "  request-7  ",
        "create proof",
        ["z.json", "a.txt"],
    )
    replay = repository.submit_run(
        conversation.id,
        "request-7",
        "create proof",
        ["a.txt", "z.json"],
    )

    assert first.created is True
    assert replay.created is False
    assert replay.run.id == first.run.id
    assert first.run.idempotency_key == "request-7"
    assert first.run.dsh_session_id == conversation.dsh_session_id
    assert first.run.runtime_input == (
        "Execute the exact user prompt delimited below.\n"
        "<<<USER_PROMPT_START:12>>>\n"
        "create proof\n"
        "<<<USER_PROMPT_END>>>\n\n"
        "Service-owned artifact requirements:\n"
        f"- You MUST write artifact `a.txt` to exactly `artifacts/{first.run.id}/a.txt`.\n"
        f"- You MUST write artifact `z.json` to exactly `artifacts/{first.run.id}/z.json`.\n"
        "- Do not rename these artifacts or substitute alternate paths."
    )
    assert first.run.user_prompt == "create proof"
    assert [artifact.requested_name for artifact in repository.list_artifacts(first.run.id)] == [
        "a.txt",
        "z.json",
    ]
    assert [event.type for event in repository.list_events(first.run.id)] == ["run.queued"]


def test_same_key_with_changed_request_conflicts(tmp_path: Path) -> None:
    repository, module = make_store(tmp_path / "changed-request.db")
    conversation = repository.create_conversation()
    repository.submit_run(conversation.id, "request", "first", [])

    with pytest.raises(module.ConflictError):
        repository.submit_run(conversation.id, "request", "different", [])


@pytest.mark.parametrize(
    ("key", "artifact_names"),
    [
        ("", []),
        (" " * 3, []),
        ("k" * 129, []),
        ("request", ["same.txt", "same.txt"]),
        ("request", ["../escape.txt"]),
        ("request", ["-leading.txt"]),
    ],
)
def test_submit_rejects_invalid_keys_and_artifact_names(
    tmp_path: Path, key: str, artifact_names: list[str]
) -> None:
    repository, module = make_store(tmp_path / "invalid-submit.db")
    conversation = repository.create_conversation()

    with pytest.raises(module.InvalidInputError):
        repository.submit_run(conversation.id, key, "prompt", artifact_names)


def test_exact_replay_precedes_attention_state_rejection(tmp_path: Path) -> None:
    repository, module = make_store(tmp_path / "replay-attention.db")
    conversation = repository.create_conversation()
    submission = repository.submit_run(conversation.id, "request", "prompt", [])
    repository.claim_oldest_run()
    repository.fail_run(
        submission.run.id,
        error_code="execution_uncertain",
        error_message="transport lost",
        uncertain=True,
    )

    replay = repository.submit_run(conversation.id, "request", "prompt", [])
    assert replay.created is False
    assert replay.run.id == submission.run.id

    with pytest.raises(module.ConflictError):
        repository.submit_run(conversation.id, "new-request", "prompt", [])


def test_only_one_nonterminal_run_is_admitted_per_conversation(tmp_path: Path) -> None:
    repository, module = make_store(tmp_path / "admission.db")
    conversation = repository.create_conversation()
    repository.submit_run(conversation.id, "first", "prompt", [])

    with pytest.raises(module.ConflictError):
        repository.submit_run(conversation.id, "second", "prompt", [])

    other_conversation = repository.create_conversation()
    assert repository.submit_run(other_conversation.id, "second", "prompt", []).created is True


def test_expected_nonterminal_unique_collision_maps_to_conflict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repository, module = make_store(tmp_path / "unique-collision.db")
    conversation = repository.create_conversation()
    repository.submit_run(conversation.id, "first", "prompt", [])
    real_connect = sqlite3.connect
    hide_once = True

    class EmptyCursor:
        @staticmethod
        def fetchone():
            return None

    class HideFirstNonterminalConnection(sqlite3.Connection):
        def execute(self, sql, parameters=(), /):
            nonlocal hide_once
            normalized = " ".join(sql.split())
            if hide_once and "SELECT id FROM runs" in normalized and "state IN" in normalized:
                hide_once = False
                return EmptyCursor()
            return super().execute(sql, parameters)

    def collision_connect(*args, **kwargs):
        kwargs["factory"] = HideFirstNonterminalConnection
        return real_connect(*args, **kwargs)

    monkeypatch.setattr(module.sqlite3, "connect", collision_connect)

    with pytest.raises(module.ConflictError) as captured:
        repository.submit_run(conversation.id, "second", "prompt", [])

    assert isinstance(captured.value.__cause__, sqlite3.IntegrityError)


def test_unrelated_submit_integrity_error_is_not_mapped_to_conflict(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "unrelated-integrity.db")
    conversation = repository.create_conversation()
    with sqlite3.connect(repository.database_path) as connection:
        connection.execute(
            """
            CREATE TRIGGER fail_run_insert
            BEFORE INSERT ON runs
            BEGIN
                SELECT RAISE(ABORT, 'unrelated integrity fault');
            END
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="unrelated integrity fault"):
        repository.submit_run(conversation.id, "request", "prompt", [])


def test_event_sequence_starts_at_one_and_stays_synchronized_with_run(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "events.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", []).run
    repository.claim_oldest_run()

    third = repository.append_event(run.id, "status", {"z": 1, "state": "working"})

    assert third.seq == 3
    assert third.data == {"state": "working", "z": 1}
    assert [event.seq for event in repository.list_events(run.id)] == [1, 2, 3]
    assert repository.get_run(run.id).last_event_seq == 3
    with sqlite3.connect(repository.database_path) as connection:
        assert (
            connection.execute(
                "SELECT data_json FROM run_events WHERE run_id = ? AND seq = 3", (run.id,)
            ).fetchone()[0]
            == '{"state":"working","z":1}'
        )


def test_append_event_requires_running_and_reserves_lifecycle_types(tmp_path: Path) -> None:
    repository, module = make_store(tmp_path / "event-ownership.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", []).run

    with pytest.raises(module.InvalidTransitionError):
        repository.append_event(run.id, "status", {})
    repository.claim_oldest_run()

    for event_type in LIFECYCLE_EVENT_TYPES:
        with pytest.raises(module.InvalidInputError):
            repository.append_event(run.id, event_type, {})

    assert repository.get_run(run.id).last_event_seq == 2
    assert [event.type for event in repository.list_events(run.id)] == [
        "run.queued",
        "run.started",
    ]


def test_claim_is_oldest_conditional_and_commits_started_event_atomically(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "claim.db")
    first_conversation = repository.create_conversation()
    first = repository.submit_run(first_conversation.id, "first", "prompt", []).run
    second_conversation = repository.create_conversation()
    second = repository.submit_run(second_conversation.id, "second", "prompt", []).run

    claimed_first = repository.claim_oldest_run()
    assert claimed_first is not None
    assert claimed_first.id == first.id
    assert claimed_first.state == "running"
    assert TIMESTAMP_PATTERN.fullmatch(claimed_first.started_at or "")
    assert [event.type for event in repository.list_events(first.id)] == [
        "run.queued",
        "run.started",
    ]
    assert repository.get_run(first.id).last_event_seq == 2
    assert repository.get_run(second.id).state == "queued"

    assert repository.claim_oldest_run().id == second.id
    assert repository.claim_oldest_run() is None


def test_claim_rolls_back_state_and_sequence_when_started_event_insert_fails(
    tmp_path: Path,
) -> None:
    repository, _ = make_store(tmp_path / "claim-fault.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", []).run
    install_failing_event_trigger(repository, "run.started")

    with pytest.raises(sqlite3.IntegrityError, match="injected run event failure"):
        repository.claim_oldest_run()

    unchanged = repository.get_run(run.id)
    assert unchanged.state == "queued"
    assert unchanged.started_at is None
    assert unchanged.last_event_seq == 1
    assert [event.type for event in repository.list_events(run.id)] == ["run.queued"]


def test_success_stores_immutable_artifact_blob_and_appends_terminal_event_last(
    tmp_path: Path,
) -> None:
    repository, module = make_store(tmp_path / "success.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(
        conversation.id, "request", "create artifacts", ["proof.txt", "optional.txt"]
    ).run
    repository.claim_oldest_run()
    content = bytearray(b"durable proof")

    completed = repository.complete_run_success(
        run.id,
        final_response="done",
        finish_reason="completed",
        artifacts=[
            module.ArtifactUpdate(
                requested_name="proof.txt",
                state="available",
                content=content,
                media_type="text/plain",
            ),
            module.ArtifactUpdate(requested_name="optional.txt", state="missing"),
        ],
    )
    content[:] = b"changed later"

    with (
        sqlite3.connect(repository.database_path) as connection,
        pytest.raises(sqlite3.IntegrityError),
    ):
        connection.execute(
            """
            UPDATE artifacts
            SET content = ?, sha256 = ?, byte_size = ?
            WHERE run_id = ? AND requested_name = 'proof.txt'
            """,
            (
                b"altered proof",
                "564ecfdeca864f552a59e1e303c31540f44318234925efc507e18f53c6cb1c4b",
                13,
                run.id,
            ),
        )

    assert completed.state == "succeeded"
    assert completed.final_response == "done"
    assert completed.finish_reason == "completed"
    assert [event.type for event in repository.list_events(run.id)][-1] == "run.succeeded"
    available = next(
        artifact
        for artifact in repository.list_artifacts(run.id)
        if artifact.requested_name == "proof.txt"
    )
    assert available.state == "available"
    assert available.content == b"durable proof"
    assert available.byte_size == 13
    assert available.sha256 == ("0b2503f5ae4ff33270ce64809c08fba69d3632d705c72648d32f5358b841f5b8")
    assert repository.get_available_artifact(run.id, available.id).content == b"durable proof"
    missing = next(
        artifact
        for artifact in repository.list_artifacts(run.id)
        if artifact.requested_name == "optional.txt"
    )
    assert missing.content is None
    with pytest.raises(module.NotFoundError):
        repository.get_available_artifact(run.id, missing.id)


def test_success_rolls_back_run_artifacts_and_sequence_when_terminal_event_fails(
    tmp_path: Path,
) -> None:
    repository, module = make_store(tmp_path / "success-fault.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", ["proof.txt"]).run
    repository.claim_oldest_run()
    install_failing_event_trigger(repository, "run.succeeded")

    with pytest.raises(sqlite3.IntegrityError, match="injected run event failure"):
        repository.complete_run_success(
            run.id,
            final_response="done",
            finish_reason="completed",
            artifacts=[
                module.ArtifactUpdate(
                    requested_name="proof.txt",
                    state="available",
                    content=b"proof",
                )
            ],
        )

    unchanged = repository.get_run(run.id)
    assert unchanged.state == "running"
    assert unchanged.final_response is None
    assert unchanged.finish_reason is None
    assert unchanged.finished_at is None
    assert unchanged.last_event_seq == 2
    [artifact] = repository.list_artifacts(run.id)
    assert artifact.state == "pending"
    assert artifact.content is None
    assert artifact.sha256 is None
    assert artifact.byte_size is None
    assert [event.type for event in repository.list_events(run.id)] == [
        "run.queued",
        "run.started",
    ]


def test_invalid_artifact_completion_rolls_back_run_and_terminal_event(tmp_path: Path) -> None:
    repository, module = make_store(tmp_path / "rollback.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", ["proof.txt"]).run
    repository.claim_oldest_run()

    with pytest.raises(module.InvalidInputError):
        repository.complete_run_success(
            run.id,
            final_response="done",
            finish_reason="completed",
            artifacts=[module.ArtifactUpdate(requested_name="proof.txt", state="available")],
        )

    assert repository.get_run(run.id).state == "running"
    assert [event.type for event in repository.list_events(run.id)] == [
        "run.queued",
        "run.started",
    ]


def test_only_completed_finish_reason_can_transition_a_run_to_success(tmp_path: Path) -> None:
    repository, module = make_store(tmp_path / "finish-reason.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", []).run
    repository.claim_oldest_run()

    with pytest.raises(module.InvalidInputError):
        repository.complete_run_success(
            run.id,
            final_response="partial",
            finish_reason="max-tokens",
            artifacts=[],
        )

    assert repository.get_run(run.id).state == "running"
    assert [event.type for event in repository.list_events(run.id)] == [
        "run.queued",
        "run.started",
    ]


def test_known_and_uncertain_failures_have_distinct_conversation_effects(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "failures.db")
    known_conversation = repository.create_conversation()
    known_run = repository.submit_run(known_conversation.id, "known", "prompt", []).run
    repository.claim_oldest_run()
    known = repository.fail_run(
        known_run.id,
        error_code="agent_outcome",
        error_message="finish reason max-tokens",
        uncertain=False,
    )

    uncertain_conversation = repository.create_conversation()
    uncertain_run = repository.submit_run(uncertain_conversation.id, "uncertain", "prompt", []).run
    repository.claim_oldest_run()
    uncertain = repository.fail_run(
        uncertain_run.id,
        error_code="execution_uncertain",
        error_message="connection lost",
        uncertain=True,
    )

    assert known.state == "failed"
    assert known.error_code == "agent_outcome"
    assert repository.get_conversation(known_conversation.id).state == "active"
    assert [event.type for event in repository.list_events(known.id)][-1] == "run.failed"
    assert uncertain.state == "failed"
    assert repository.get_conversation(uncertain_conversation.id).state == "attention_required"
    assert [event.type for event in repository.list_events(uncertain.id)][-1] == "run.failed"


def test_failure_marks_every_pending_artifact_invalid_in_the_terminal_transaction(
    tmp_path: Path,
) -> None:
    repository, _ = make_store(tmp_path / "failed-artifacts.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(
        conversation.id, "request", "prompt", ["proof.txt", "optional.txt"]
    ).run
    repository.claim_oldest_run()

    repository.fail_run(
        run.id,
        error_code="runtime_unavailable",
        error_message="runtime failed to start",
        uncertain=False,
    )

    assert [artifact.state for artifact in repository.list_artifacts(run.id)] == [
        "invalid",
        "invalid",
    ]


def test_uncertain_failure_rolls_back_run_conversation_and_sequence_when_event_fails(
    tmp_path: Path,
) -> None:
    repository, _ = make_store(tmp_path / "failure-fault.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", ["proof.txt"]).run
    repository.claim_oldest_run()
    install_failing_event_trigger(repository, "run.failed")

    with pytest.raises(sqlite3.IntegrityError, match="injected run event failure"):
        repository.fail_run(
            run.id,
            error_code="execution_uncertain",
            error_message="transport lost",
            uncertain=True,
        )

    unchanged = repository.get_run(run.id)
    assert unchanged.state == "running"
    assert unchanged.error_code is None
    assert unchanged.error_message is None
    assert unchanged.finished_at is None
    assert unchanged.last_event_seq == 2
    assert repository.get_conversation(conversation.id).state == "active"
    assert repository.list_artifacts(run.id)[0].state == "pending"
    assert [event.type for event in repository.list_events(run.id)] == [
        "run.queued",
        "run.started",
    ]


def test_startup_recovery_fails_running_runs_and_preserves_queued_runs(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "recovery.db")
    running_conversation = repository.create_conversation()
    running = repository.submit_run(running_conversation.id, "running", "prompt", ["proof.txt"]).run
    repository.claim_oldest_run()
    queued_conversation = repository.create_conversation()
    queued = repository.submit_run(queued_conversation.id, "queued", "prompt", []).run

    recovered = repository.recover_running_runs()

    assert recovered == 1
    recovered_run = repository.get_run(running.id)
    assert recovered_run.state == "failed"
    assert recovered_run.error_code == "execution_uncertain"
    assert repository.get_conversation(running_conversation.id).state == "attention_required"
    assert repository.list_artifacts(running.id)[0].state == "invalid"
    assert [event.type for event in repository.list_events(running.id)][-1] == "run.failed"
    assert repository.get_run(queued.id).state == "queued"
    assert [run.id for run in repository.list_queued_runs()] == [queued.id]


def test_startup_recovery_rolls_back_all_mutations_when_terminal_event_fails(
    tmp_path: Path,
) -> None:
    repository, _ = make_store(tmp_path / "recovery-fault.db")
    conversation = repository.create_conversation()
    run = repository.submit_run(conversation.id, "request", "prompt", ["proof.txt"]).run
    repository.claim_oldest_run()
    install_failing_event_trigger(repository, "run.failed")

    with pytest.raises(sqlite3.IntegrityError, match="injected run event failure"):
        repository.recover_running_runs()

    unchanged = repository.get_run(run.id)
    assert unchanged.state == "running"
    assert unchanged.error_code is None
    assert unchanged.error_message is None
    assert unchanged.finished_at is None
    assert unchanged.last_event_seq == 2
    assert repository.get_conversation(conversation.id).state == "active"
    assert repository.list_artifacts(run.id)[0].state == "pending"
    assert [event.type for event in repository.list_events(run.id)] == [
        "run.queued",
        "run.started",
    ]


def test_acknowledgement_rotates_session_and_keeps_historical_run_snapshot(tmp_path: Path) -> None:
    repository, _ = make_store(tmp_path / "acknowledge.db")
    conversation = repository.create_conversation()
    historical = repository.submit_run(conversation.id, "request", "prompt", []).run
    repository.claim_oldest_run()
    repository.fail_run(
        historical.id,
        error_code="execution_uncertain",
        error_message="uncertain",
        uncertain=True,
    )

    acknowledged = repository.acknowledge_recovery(conversation.id)
    replay = repository.acknowledge_recovery(conversation.id)

    assert acknowledged.state == "active"
    assert acknowledged.dsh_session_id != conversation.dsh_session_id
    assert replay.dsh_session_id == acknowledged.dsh_session_id
    assert repository.get_run(historical.id).dsh_session_id == conversation.dsh_session_id


def test_concurrent_same_key_submissions_create_one_run_and_one_queued_event(
    tmp_path: Path,
) -> None:
    repository, _ = make_store(tmp_path / "concurrent.db")
    conversation = repository.create_conversation()

    def submit():
        return repository.submit_run(conversation.id, "same-key", "prompt", ["proof.txt"])

    with ThreadPoolExecutor(max_workers=4) as executor:
        submissions = list(executor.map(lambda _: submit(), range(4)))

    assert len({submission.run.id for submission in submissions}) == 1
    assert sum(submission.created for submission in submissions) == 1
    run = submissions[0].run
    assert [event.type for event in repository.list_events(run.id)] == ["run.queued"]
    assert len(repository.list_runs(conversation.id)) == 1
