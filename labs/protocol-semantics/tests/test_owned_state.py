import tempfile
from pathlib import Path

from protocol_labs.jsonl_peer import CloseOutcome
from protocol_labs.owned_state import OwnedState


def _closed(*, group_gone: bool) -> CloseOutcome:
    return CloseOutcome(
        returncode=0,
        shutdown_request_succeeded=None,
        eof_exited_cleanly=True,
        escalation_signal=None,
        group_gone=group_gone,
        diagnostics=(),
    )


def test_state_requires_every_owner_and_independent_group_confirmation(
    monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    state = OwnedState.create(prefix="owned-test-", owner_ids={"first", "second"})
    state.confirm_closed("first", _closed(group_gone=True), group_absent=True)
    state.cleanup_if_confirmed()
    assert state.root.is_dir()

    state.confirm_closed("first", _closed(group_gone=True), group_absent=True)
    state.cleanup_if_confirmed()
    assert state.root.is_dir()

    state.confirm_closed("second", _closed(group_gone=True), group_absent=False)
    state.cleanup_if_confirmed()
    assert state.root.is_dir()

    state.confirm_closed("second", _closed(group_gone=False), group_absent=True)
    state.cleanup_if_confirmed()
    assert state.root.is_dir()

    state.confirm_closed("second", _closed(group_gone=True), group_absent=True)
    state.cleanup_if_confirmed()
    assert not state.root.exists()
