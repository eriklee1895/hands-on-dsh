import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface RuntimeRunResult {
  finalResponse: string;
  /** Untrusted compatibility field. The coordinator verifies artifacts from disk. */
  artifact?: { filename: string; mediaType: string; bytes: Uint8Array };
}

export interface RuntimeRunInput {
  sessionId: string;
  prompt: string;
  onNotification(notification: { method: string; params: Record<string, unknown> }): void;
}

export interface DshRuntimePort {
  readonly generation: number;
  readonly activeRuns: number;
  readonly workspaceRoot: string;
  run(input: RuntimeRunInput): Promise<RuntimeRunResult>;
  restart(): Promise<void>;
  /** Force-close the whole runtime transport and settle every active operation. */
  shutdown(): Promise<void>;
  close(): Promise<void>;
}

export class RuntimeTransportUncertainError extends Error {
  constructor(message = "runtime transport outcome is uncertain", options?: ErrorOptions) {
    super(message, options);
    this.name = "RuntimeTransportUncertainError";
  }
}

export class FakeDshRuntime implements DshRuntimePort {
  generation = 1;
  activeRuns = 0;
  delayMs = 0;
  failNext: "known" | "uncertain" | undefined;
  readonly memories = new Map<string, string[]>();
  private closed = false;
  private readonly shutdownWaiters = new Set<(error: Error) => void>();

  constructor(readonly workspaceRoot: string) {}

  async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    if (this.closed) throw new Error("runtime is closed");
    this.activeRuns += 1;
    try {
      if (this.delayMs > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.shutdownWaiters.delete(onShutdown);
            resolve();
          }, this.delayMs);
          const onShutdown = (error: Error) => {
            clearTimeout(timer);
            this.shutdownWaiters.delete(onShutdown);
            reject(error);
          };
          this.shutdownWaiters.add(onShutdown);
        });
      }
      const failure = this.failNext;
      this.failNext = undefined;
      if (failure === "uncertain") throw new RuntimeTransportUncertainError();
      if (failure === "known") throw new Error("known fake failure");
      const emit = (type: string, data: unknown) =>
        input.onNotification({
          method: "session.event",
          params: { sessionId: input.sessionId, event: { type, seq: 0, time: 0, data } },
        });
      const memory = this.memories.get(input.sessionId) ?? [];
      const turn = memory.length + 1;
      const callId = `fake-${input.sessionId}-${this.generation}-${turn}`;
      emit("step/start", { turn, step: 1 });
      emit("assistant/chunk", {
        turn,
        step: 1,
        chunk: { type: "text-delta", index: 0, text: "done" },
      });
      emit("assistant/message", {
        turn,
        step: 1,
        message: {
          content: [
            { type: "text", text: "done" },
            {
              type: "tool-call",
              id: callId,
              name: "write_stage4_proof",
              arguments: JSON.stringify({ content: input.prompt }),
            },
          ],
        },
      });
      emit("tool/call", {
        turn,
        step: 1,
        callId,
        name: "write_stage4_proof",
        arguments: JSON.stringify({ content: input.prompt }),
      });
      const digest = createHash("sha256")
        .update(`stage5-proof-v1\0${input.sessionId}\0${callId}`)
        .digest("hex");
      const partition = join(this.workspaceRoot, digest);
      await mkdir(partition, { mode: 0o700 });
      await writeFile(join(partition, "stage4-proof.txt"), input.prompt, {
        flag: "wx",
        mode: 0o600,
      });
      emit("tool/result", {
        turn,
        step: 1,
        message: {
          content: [
            {
              type: "tool-result",
              toolCallId: callId,
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    path: "stage4-proof.txt",
                    bytes: Buffer.byteLength(input.prompt),
                  }),
                },
              ],
              isError: false,
            },
          ],
        },
      });
      emit("step/end", { turn, step: 1 });
      memory.push(input.prompt);
      this.memories.set(input.sessionId, memory);
      return {
        finalResponse: "done",
        artifact: {
          filename: "stage4-proof.txt",
          mediaType: "text/plain",
          bytes: Buffer.from(input.prompt),
        },
      };
    } finally {
      this.activeRuns -= 1;
    }
  }

  async restart(): Promise<void> {
    if (this.activeRuns !== 0) throw new Error("runtime has active runs");
    if (this.closed) throw new Error("runtime is closed");
    this.generation += 1;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.activeRuns !== 0) throw new Error("runtime has active runs");
    this.closed = true;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = new RuntimeTransportUncertainError("runtime was shut down while work was active");
    for (const reject of this.shutdownWaiters) reject(error);
    this.shutdownWaiters.clear();
  }
}
