"""One-worker coordinator that treats SQLite as the durable execution queue."""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from pathlib import Path

from .artifacts import RetainedArtifactDirectory
from .domain import Conversation, Run, RunSubmission
from .events import RuntimeEvent
from .notifier import RunNotifier
from .runtime import (
    ExecutionUncertainError,
    RuntimeAdapter,
    RuntimeUnavailableError,
)
from .store import SQLiteStore


class CoordinatorClosedError(Exception):
    """Raised when admission is attempted outside the coordinator lifetime."""


class RunCoordinator:
    """Own startup recovery, one durable worker, and graceful runtime shutdown."""

    def __init__(
        self,
        store: SQLiteStore,
        adapter: RuntimeAdapter,
        workspace: str | Path,
        *,
        notifier: RunNotifier | None = None,
        poll_interval: float = 1.0,
    ) -> None:
        self._store = store
        self._adapter = adapter
        self._workspace = Path(workspace)
        self.notifier = notifier or RunNotifier()
        self._poll_interval = poll_interval
        self._wake = asyncio.Event()
        self._gate = asyncio.Lock()
        self._lifecycle_lock = asyncio.Lock()
        self._close_requested = asyncio.Event()
        self._worker: asyncio.Task[None] | None = None
        self._lifecycle_state = "new"
        self._accepting = False
        self._stopping = False

    @property
    def accepting(self) -> bool:
        """Return whether the coordinator currently admits new Runs."""
        return self._accepting

    @property
    def worker_running(self) -> bool:
        """Return whether the durable worker task exists and has not settled."""
        return self._worker is not None and not self._worker.done()

    async def start(self) -> None:
        """Migrate, recover uncertain legacy work, and begin durable polling."""
        async with self._lifecycle_lock:
            if self._lifecycle_state == "started":
                return
            self._require_startable()
            self._lifecycle_state = "starting"
            try:
                await asyncio.to_thread(self._store.migrate)
                self._reject_requested_close()
                legacy_running = await asyncio.to_thread(self._store.list_running_runs)
                self._reject_requested_close()
                await asyncio.to_thread(self._store.recover_running_runs)
                self._reject_requested_close()
                for run in legacy_running:
                    self.notifier.publish(run.id)
                async with self._gate:
                    self._reject_requested_close()
                    self._stopping = False
                    self._accepting = True
                    self._worker = asyncio.create_task(
                        self._worker_loop(), name="recoverable-run-worker"
                    )
                    self._wake.set()
                self._lifecycle_state = "started"
            except BaseException:
                self._lifecycle_state = "new"
                raise

    async def submit_run(
        self,
        conversation_id: str,
        idempotency_key: object,
        prompt: object,
        artifact_names: Sequence[str],
    ) -> RunSubmission:
        """Durably admit a Run and wake the worker only for a new record."""
        async with self._gate:
            self._require_accepting()
            submission = await asyncio.to_thread(
                self._store.submit_run,
                conversation_id,
                idempotency_key,
                prompt,
                artifact_names,
            )
            if submission.created:
                self.notifier.publish(submission.run.id)
                self._wake.set()
            return submission

    async def acknowledge_recovery(self, conversation_id: str) -> Conversation:
        """Rotate the uncertain DSH session and wake any newly eligible durable work."""
        async with self._gate:
            self._require_accepting()
            conversation = await asyncio.to_thread(
                self._store.acknowledge_recovery, conversation_id
            )
            self._wake.set()
            return conversation

    async def close(self) -> None:
        """Stop admission, settle active uncancellable work, then close the adapter."""
        self._close_requested.set()
        async with self._lifecycle_lock:
            if self._lifecycle_state == "closed":
                return
            async with self._gate:
                self._accepting = False
                self._stopping = True
                self._wake.set()
            self._lifecycle_state = "stopping"
            worker_error: BaseException | None = None
            worker = self._worker
            if worker is not None:
                try:
                    await worker
                except BaseException as error:
                    worker_error = error
                finally:
                    self._worker = None
            cleanup_error: BaseException | None = None
            try:
                await self._adapter.close()
            except BaseException as error:
                cleanup_error = error
            else:
                self._lifecycle_state = "closed"

            if worker_error is not None:
                if cleanup_error is not None:
                    raise worker_error from cleanup_error
                raise worker_error
            if cleanup_error is not None:
                raise cleanup_error

    async def _worker_loop(self) -> None:
        while True:
            run = await self._claim_next()
            if run is not None:
                self.notifier.publish(run.id)
                await self._execute_run(run)
                continue
            if self._stopping:
                return
            self._wake.clear()
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=self._poll_interval)
            except asyncio.TimeoutError:
                continue

    async def _claim_next(self) -> Run | None:
        async with self._gate:
            if self._stopping:
                return None
            return await asyncio.to_thread(self._store.claim_oldest_run)

    async def _execute_run(self, run: Run) -> None:
        artifacts = await asyncio.to_thread(self._store.list_artifacts, run.id)
        names = [artifact.requested_name for artifact in artifacts]
        try:
            retained = await asyncio.to_thread(
                RetainedArtifactDirectory.create, self._workspace, run.id
            )
        except Exception as error:
            await self._fail(
                run.id,
                error_code="runtime_unavailable",
                error_message=str(error) or type(error).__name__,
                uncertain=False,
            )
            return

        async def emit(event: RuntimeEvent) -> None:
            await asyncio.to_thread(self._store.append_event, run.id, event.type, event.data)
            self.notifier.publish(run.id)

        try:
            try:
                result = await self._adapter.run(run.dsh_session_id, run.runtime_input, emit)
            except RuntimeUnavailableError as error:
                await self._fail(
                    run.id,
                    error_code="runtime_unavailable",
                    error_message=str(error) or type(error).__name__,
                    uncertain=False,
                )
                return
            except ExecutionUncertainError as error:
                await self._fail(
                    run.id,
                    error_code="execution_uncertain",
                    error_message=str(error) or type(error).__name__,
                    uncertain=True,
                )
                return
            except Exception as error:
                await self._fail(
                    run.id,
                    error_code="execution_uncertain",
                    error_message=str(error) or type(error).__name__,
                    uncertain=True,
                )
                return

            if result.finish_reason != "completed":
                await self._fail(
                    run.id,
                    error_code="agent_outcome",
                    error_message=f"agent finished with reason {result.finish_reason!r}",
                    uncertain=False,
                )
                return

            try:
                updates = await asyncio.to_thread(retained.snapshot, names)
            except Exception as error:
                await self._fail(
                    run.id,
                    error_code="artifact_snapshot_failed",
                    error_message=str(error) or type(error).__name__,
                    uncertain=False,
                )
                return
            await asyncio.to_thread(
                self._store.complete_run_success,
                run.id,
                final_response=result.final_response,
                finish_reason=result.finish_reason,
                artifacts=updates,
            )
            self.notifier.publish(run.id)
        finally:
            await asyncio.to_thread(retained.close)

    async def _fail(
        self,
        run_id: str,
        *,
        error_code: str,
        error_message: str,
        uncertain: bool,
    ) -> None:
        await asyncio.to_thread(
            self._store.fail_run,
            run_id,
            error_code=error_code,
            error_message=error_message,
            uncertain=uncertain,
        )
        self.notifier.publish(run_id)

    def _require_accepting(self) -> None:
        if not self._accepting:
            raise CoordinatorClosedError("coordinator is not accepting new work")

    def _require_startable(self) -> None:
        if self._lifecycle_state in {"stopping", "closed"} or self._close_requested.is_set():
            raise CoordinatorClosedError("coordinator is closed")

    def _reject_requested_close(self) -> None:
        if self._close_requested.is_set():
            raise CoordinatorClosedError("coordinator close was requested during startup")
