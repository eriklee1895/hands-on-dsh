import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { AuthoritativeStore } from "./store.js";
import { AguiProjector } from "./projector.js";
import { PersistedSubscriptions } from "./subscriptions.js";
import { RuntimeTransportUncertainError, type DshRuntimePort } from "./runtime.js";

class RawAuthorityUnavailableError extends Error {
  constructor(cause: unknown) {
    super("raw DSH authority failed and unknown settlement did not persist", { cause });
    this.name = "RawAuthorityUnavailableError";
  }
}

class ArtifactSnapshotPersistenceError extends Error {
  constructor(cause: unknown) {
    super("proof artifact could not be persisted; partition retained as quarantine", { cause });
    this.name = "ArtifactSnapshotPersistenceError";
  }
}

export class RunCoordinator {
  readonly subscriptions: PersistedSubscriptions;
  private readonly active = new Set<string>();
  private readonly pending: Array<{ runId: string; conversationId: string; prompt: string }> = [];
  private readonly idleWaiters = new Set<() => void>();
  private readonly concurrency = 2;
  private readonly runDeadlineMs: number;
  private closed = false;
  private admissionStopped = false;
  private runtimeUnavailable = false;
  private fatalError: Error | undefined;

  constructor(
    readonly store: AuthoritativeStore,
    readonly runtime: DshRuntimePort,
    options: { runDeadlineMs?: number } = {},
  ) {
    this.runDeadlineMs = options.runDeadlineMs ?? 120_000;
    if (!Number.isSafeInteger(this.runDeadlineMs) || this.runDeadlineMs <= 0)
      throw new Error("runDeadlineMs must be a positive integer");
    this.subscriptions = new PersistedSubscriptions(store);
    for (const queued of store.recoverStartup()) {
      const run = store.getRun(queued.runId)!;
      const request = queued.request;
      if (
        typeof request !== "object" ||
        request === null ||
        Array.isArray(request) ||
        typeof request.message !== "string"
      )
        throw new Error(`queued run ${queued.runId} has no accepted message`);
      this.pending.push({
        runId: queued.runId,
        conversationId: run.conversationId,
        prompt: request.message,
      });
    }
    this.pump();
  }

  private async runToDrain(input: Parameters<DshRuntimePort["run"]>[0]) {
    let timer: NodeJS.Timeout | undefined;
    const settled = this.runtime.run(input).then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const deadline = new Promise<{ kind: "deadline" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "deadline" }), this.runDeadlineMs);
    });
    const first = await Promise.race([settled, deadline]);
    if (timer !== undefined) clearTimeout(timer);
    if (first.kind === "value") return first.value;
    if (first.kind === "error") throw first.error;
    const final = await settled;
    if (final.kind === "error" && final.error instanceof RuntimeTransportUncertainError)
      throw final.error;
    throw new Error(`run exceeded ${this.runDeadlineMs}ms deadline after draining to idle`);
  }

  private settleSharedRuntimeLoss(): void {
    this.runtimeUnavailable = true;
    for (const runId of this.active) {
      if (this.store.getRun(runId)?.status === "running") this.store.markExecutionUnknown(runId);
    }
    this.subscriptions.notify();
  }

  admit(input: { runId: string; conversationId: string; prompt: string }) {
    if (this.closed || this.admissionStopped) throw new Error("coordinator is closed");
    if (this.fatalError !== undefined)
      throw new Error(`coordinator is unavailable: ${this.fatalError.message}`);
    if (this.runtimeUnavailable) throw new Error("runtime is unavailable until an idle restart");
    if (input.prompt.length === 0 || input.prompt.length > 16_000)
      throw new Error("invalid prompt length");
    const admission = this.store.admitRun({
      id: input.runId,
      conversationId: input.conversationId,
      request: { message: input.prompt },
    });
    if (!admission.created) return admission;
    this.subscriptions.notify();
    this.pending.push(input);
    this.pump();
    return admission;
  }

  private pump(): void {
    if (
      this.closed ||
      this.admissionStopped ||
      this.runtimeUnavailable ||
      this.fatalError !== undefined
    )
      return;
    while (this.active.size < this.concurrency) {
      const input = this.pending.shift();
      if (input === undefined) return;
      this.active.add(input.runId);
      void this.execute(input)
        .catch((error: unknown) => this.latchFatal(input.runId, error))
        .finally(() => {
          this.active.delete(input.runId);
          this.subscriptions.notify();
          this.pump();
          if (this.active.size === 0) {
            for (const resolve of this.idleWaiters) resolve();
            this.idleWaiters.clear();
          }
        });
    }
  }

  private latchFatal(runId: string, error: unknown): void {
    const primary = error instanceof Error ? error : new Error(String(error));
    this.runtimeUnavailable = true;
    try {
      if (this.store.getRun(runId)?.status === "running") this.store.markExecutionUnknown(runId);
      this.fatalError ??= primary;
    } catch (terminalError) {
      this.fatalError ??= new AggregateError(
        [primary, terminalError],
        "execution and fatal unknown settlement failed",
      );
    }
  }

  private async cleanupProofPartition(sessionId: string, callId: string): Promise<void> {
    const workspace = await realpath(this.runtime.workspaceRoot);
    const digest = createHash("sha256")
      .update(`stage5-proof-v1\0${sessionId}\0${callId}`)
      .digest("hex");
    const partitionPath = join(workspace, digest);
    let partitionMetadata;
    try {
      partitionMetadata = await lstat(partitionPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    if (
      !partitionMetadata.isDirectory() ||
      partitionMetadata.isSymbolicLink() ||
      (partitionMetadata.mode & 0o777) !== 0o700
    )
      throw new Error("refusing cleanup of a non-owned proof partition");
    const canonical = await realpath(partitionPath);
    if (!canonical.startsWith(`${resolve(workspace)}${sep}`))
      throw new Error("refusing cleanup of a proof partition outside workspace");
    const entries = await readdir(partitionPath, { withFileTypes: true });
    if (entries.some((entry) => entry.name !== "stage4-proof.txt"))
      throw new Error("refusing cleanup of a proof partition containing foreign entries");
    for (const entry of entries) {
      if (entry.isDirectory()) throw new Error("refusing cleanup of a directory-shaped proof");
      await unlink(join(partitionPath, entry.name));
    }
    await rmdir(partitionPath);
  }

  private async snapshotProofArtifact(
    runId: string,
    sessionId: string,
    callId: string,
    prompt: string,
  ): Promise<boolean> {
    const digest = createHash("sha256")
      .update(`stage5-proof-v1\0${sessionId}\0${callId}`)
      .digest("hex");
    const workspace = await realpath(this.runtime.workspaceRoot);
    const partitionPath = join(workspace, digest);
    let partitionMetadata;
    try {
      partitionMetadata = await lstat(partitionPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
    if (
      !partitionMetadata.isDirectory() ||
      partitionMetadata.isSymbolicLink() ||
      (partitionMetadata.mode & 0o777) !== 0o700
    )
      throw new Error("proof partition is not an owned 0700 directory");
    const canonicalPartition = await realpath(partitionPath);
    if (!canonicalPartition.startsWith(`${resolve(workspace)}${sep}`))
      throw new Error("proof partition escaped workspace");
    const proofPath = join(partitionPath, "stage4-proof.txt");
    const rawProofMetadata = await lstat(proofPath);
    if (
      !rawProofMetadata.isFile() ||
      rawProofMetadata.isSymbolicLink() ||
      (rawProofMetadata.mode & 0o777) !== 0o600
    )
      throw new Error("proof is not an owned 0600 regular file");
    const canonicalProof = await realpath(proofPath);
    if (!canonicalProof.startsWith(`${resolve(workspace)}${sep}`))
      throw new Error("proof escaped workspace");
    const bytes = await readFile(canonicalProof);
    if (!bytes.equals(Buffer.from(prompt)))
      throw new Error("proof bytes do not match accepted prompt");
    try {
      this.store.saveArtifact({
        id: randomUUID(),
        runId,
        filename: "stage4-proof.txt",
        mediaType: "text/plain",
        bytes,
      });
    } catch (error) {
      throw new ArtifactSnapshotPersistenceError(error);
    }
    return true;
  }

  private async execute(input: {
    runId: string;
    conversationId: string;
    prompt: string;
  }): Promise<void> {
    let proofSessionId: string | undefined;
    let proofCallId: string | undefined;
    let proofSnapshotted = false;
    try {
      this.store.startRun(input.runId);
      this.subscriptions.notify();
      const conversation = this.store.getConversation(input.conversationId)!;
      proofSessionId = conversation.dshSessionRef;
      const projector = new AguiProjector(conversation.dshSessionRef);
      let callbackFailure: unknown;
      let rawAuthorityFailure = false;
      let proofResultSeen = false;
      const result = await this.runToDrain({
        sessionId: conversation.dshSessionRef,
        prompt: input.prompt,
        onNotification: (notification) => {
          const event = notification.params.event as
            | { type?: unknown; data?: Record<string, unknown> }
            | undefined;
          if (
            notification.method === "session.event" &&
            notification.params.sessionId === conversation.dshSessionRef &&
            event?.type === "tool/call" &&
            event.data?.name === "write_stage4_proof"
          ) {
            if (proofCallId !== undefined)
              callbackFailure ??= new Error("multiple proof tool calls");
            else if (typeof event.data.callId !== "string" || event.data.callId === "")
              callbackFailure ??= new Error("proof tool call id is missing");
            else proofCallId = event.data.callId;
          }
          try {
            this.store.appendEvent(input.runId, "raw-dsh", notification.method, notification);
          } catch (error) {
            rawAuthorityFailure = true;
            callbackFailure ??= error;
            return;
          } finally {
            this.subscriptions.notify();
          }
          if (this.store.getRun(input.runId)?.status !== "running") return;
          if (callbackFailure !== undefined) return;
          try {
            if (
              notification.method === "session.event" &&
              notification.params.sessionId === conversation.dshSessionRef &&
              event?.type === "tool/result" &&
              proofCallId !== undefined
            ) {
              const message = event.data?.message;
              const content =
                typeof message === "object" && message !== null && !Array.isArray(message)
                  ? (message as Record<string, unknown>).content
                  : undefined;
              const result = Array.isArray(content)
                ? content.find(
                    (block) =>
                      typeof block === "object" &&
                      block !== null &&
                      !Array.isArray(block) &&
                      (block as Record<string, unknown>).type === "tool-result" &&
                      (block as Record<string, unknown>).toolCallId === proofCallId,
                  )
                : undefined;
              if (result !== undefined) {
                if (proofResultSeen) throw new Error("multiple proof tool results");
                if ((result as Record<string, unknown>).isError === true)
                  throw new Error("proof tool result reported an error");
                proofResultSeen = true;
              }
            }
            for (const projected of projector.accept(notification))
              this.store.appendEvent(input.runId, "ag-ui", projected.type, projected);
          } catch (error) {
            callbackFailure ??= error;
          } finally {
            this.subscriptions.notify();
          }
        },
      });
      void result;
      if (this.store.getRun(input.runId)?.status !== "running") return;
      if (rawAuthorityFailure) {
        try {
          this.store.markExecutionUnknown(input.runId);
        } catch (error) {
          throw new RawAuthorityUnavailableError(error);
        }
        return;
      }
      if (callbackFailure !== undefined) throw callbackFailure;
      projector.assertClosed();
      if (proofCallId === undefined) throw new Error("proof tool was not called exactly once");
      if (!proofResultSeen) throw new Error("proof tool result was not observed exactly once");
      proofSnapshotted = await this.snapshotProofArtifact(
        input.runId,
        conversation.dshSessionRef,
        proofCallId,
        input.prompt,
      );
      if (!proofSnapshotted) throw new Error("proof artifact is missing");
      await this.cleanupProofPartition(conversation.dshSessionRef, proofCallId);
      this.store.finishRun(input.runId, "succeeded");
    } catch (error) {
      if (error instanceof RuntimeTransportUncertainError) this.settleSharedRuntimeLoss();
      else if (error instanceof RawAuthorityUnavailableError) throw error;
      else if (error instanceof ArtifactSnapshotPersistenceError) throw error;
      else if (this.store.getRun(input.runId)?.status === "running")
        this.store.finishRun(input.runId, "failed", {
          code: "RUN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      if (proofSessionId !== undefined && proofCallId !== undefined) {
        let preservePartition = false;
        if (!proofSnapshotted) {
          try {
            proofSnapshotted = await this.snapshotProofArtifact(
              input.runId,
              proofSessionId,
              proofCallId,
              input.prompt,
            );
          } catch (snapshotError) {
            if (snapshotError instanceof ArtifactSnapshotPersistenceError) {
              preservePartition = true;
              this.fatalError ??= snapshotError;
            }
          }
        }
        try {
          if (!preservePartition) await this.cleanupProofPartition(proofSessionId, proofCallId);
        } catch (cleanupError) {
          this.fatalError ??=
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        }
      }
      this.subscriptions.notify();
    }
  }

  async restartRuntime(): Promise<void> {
    if (this.closed || this.admissionStopped) throw new Error("coordinator is closed");
    if (this.fatalError !== undefined)
      throw new Error(`coordinator fatal error prevents restart: ${this.fatalError.message}`);
    if (this.active.size !== 0) throw new Error("active runs prevent restart");
    await this.runtime.restart();
    this.runtimeUnavailable = false;
    this.pump();
  }

  whenIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private waitForActiveGrace(graceMs: number): Promise<boolean> {
    if (this.active.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(onIdle);
        resolve(value);
      };
      const onIdle = () => finish(true);
      const timer = setTimeout(() => finish(false), graceMs);
      this.idleWaiters.add(onIdle);
      if (this.active.size === 0) onIdle();
    });
  }

  async shutdown(options: { graceMs?: number } = {}): Promise<void> {
    if (this.closed) return;
    const graceMs = options.graceMs ?? 1_000;
    if (!Number.isSafeInteger(graceMs) || graceMs <= 0)
      throw new Error("shutdown graceMs must be a positive integer");
    this.admissionStopped = true;
    this.subscriptions.shutdown();
    if (await this.waitForActiveGrace(graceMs)) {
      await this.runtime.close();
      this.closed = true;
      return;
    }
    this.runtimeUnavailable = true;
    const settlementErrors: unknown[] = [];
    for (const runId of this.active) {
      try {
        if (this.store.getRun(runId)?.status === "running") this.store.markExecutionUnknown(runId);
      } catch (error) {
        settlementErrors.push(error);
      }
    }
    this.subscriptions.notify();
    await this.runtime.shutdown();
    if (!(await this.waitForActiveGrace(graceMs)))
      settlementErrors.push(new Error("runtime shutdown did not settle active operations"));
    if (settlementErrors.length > 0) {
      const fatal = new AggregateError(settlementErrors, "shutdown unknown settlement failed");
      this.fatalError ??= fatal;
      this.closed = true;
      throw fatal;
    }
    this.closed = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.admissionStopped = true;
    if (this.active.size !== 0 || this.pending.length !== 0)
      throw new Error("active runs prevent close");
    await this.runtime.close();
    this.subscriptions.shutdown();
    this.closed = true;
  }
}
