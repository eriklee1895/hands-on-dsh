"""Disposable probe state retained until every started process group is reaped."""

from __future__ import annotations

import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from protocol_labs.jsonl_peer import CloseOutcome


@dataclass
class OwnedState:
    """Own one disposable workspace and delete it only after confirmed cleanup."""

    root: Path
    owner_ids: frozenset[str]
    confirmed_owner_ids: set[str] = field(default_factory=set)

    @classmethod
    def create(cls, *, prefix: str, owner_ids: set[str]) -> OwnedState:
        """Create a fresh workspace, process home, and Harness home."""
        if not owner_ids:
            raise ValueError("owned state requires at least one owner")
        root = Path(tempfile.mkdtemp(prefix=prefix))
        for name in ("workspace", "home", "dsh-home"):
            (root / name).mkdir()
        return cls(root=root, owner_ids=frozenset(owner_ids))

    def confirm_closed(self, owner_id: str, outcome: CloseOutcome, *, group_absent: bool) -> None:
        """Count an owner only when close and an independent group check agree."""
        if owner_id not in self.owner_ids:
            raise ValueError("owner is not part of this state")
        if outcome.group_gone and group_absent:
            self.confirmed_owner_ids.add(owner_id)

    def cleanup_if_confirmed(self) -> None:
        """Keep the tree after failed startup or any unconfirmed process exit."""
        if self.confirmed_owner_ids == self.owner_ids:
            shutil.rmtree(self.root)
