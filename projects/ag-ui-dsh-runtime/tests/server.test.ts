import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { HttpAgent } from "@ag-ui/client";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { createServer, listenLocal } from "../src/server/app.ts";
import { RunCoordinator } from "../src/server/coordinator.ts";
import {
  RuntimeTransportUncertainError,
  FakeDshRuntime,
  type DshRuntimePort,
  type RuntimeRunInput,
  type RuntimeRunResult,
} from "../src/server/runtime.ts";
import { AuthoritativeStore } from "../src/server/store.ts";
import { PersistedSubscriptions } from "../src/server/subscriptions.ts";
import {
  SourceRuntimeManager,
  type HarnessFactory,
  type SourceEvidence,
} from "../src/server/source-runtime.ts";

const roots: string[] = [];
const coordinators = new WeakMap<AuthoritativeStore, RunCoordinator>();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(runtime: DshRuntimePort) {
  const root = await mkdtemp(join(tmpdir(), "agui-server-"));
  roots.push(root);
  await mkdir(runtime.workspaceRoot, { recursive: true, mode: 0o700 });
  const store = new AuthoritativeStore(join(root, "app.db"));
  const coordinator = new RunCoordinator(store, runtime);
  coordinators.set(store, coordinator);
  return { root, store, coordinator };
}

async function uniqueWorkspace(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function terminal(store: AuthoritativeStore, runId: string) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const run = store.getRun(runId);
    if (run !== undefined && ["succeeded", "failed", "execution_unknown"].includes(run.status)) {
      await coordinators.get(store)?.whenIdle();
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} did not become terminal`);
}

class BaseRuntime implements DshRuntimePort {
  generation = 1;
  activeRuns = 0;

  constructor(readonly workspaceRoot: string) {}

  async run(_input: RuntimeRunInput): Promise<RuntimeRunResult> {
    return { finalResponse: "" };
  }

  async restart(): Promise<void> {
    if (this.activeRuns !== 0) throw new Error("runtime has active runs");
    this.generation += 1;
  }

  async close(): Promise<void> {
    if (this.activeRuns !== 0) throw new Error("runtime has active runs");
  }

  async shutdown(): Promise<void> {
    await this.close();
  }
}

function notification(type: string, data: unknown, sessionId: string) {
  return {
    method: "session.event",
    params: { sessionId, event: { type, seq: 1, time: 0, data } },
  };
}

describe("coordinator", () => {
  test("requeues an admitted queued run from its immutable request on startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "agui-requeue-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const store = new AuthoritativeStore(join(root, "app.db"));
    store.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    store.admitRun({ id: "queued", conversationId: "c1", request: { message: "queued proof" } });
    const coordinator = new RunCoordinator(store, new FakeDshRuntime(workspace));
    coordinators.set(store, coordinator);

    expect((await terminal(store, "queued")).status).toBe("succeeded");
    expect(store.getArtifact(store.listArtifacts("queued")[0]!.id)?.bytes.toString()).toBe(
      "queued proof",
    );
    await coordinator.close();
    store.close();
  });

  test("latches a projector failure without throwing into the synchronous runtime callback", async () => {
    class DrainingRuntime extends BaseRuntime {
      callbackThrew = false;
      emitted = 0;

      override async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
        const emit = (type: string, data: unknown) => {
          this.emitted += 1;
          try {
            input.onNotification(notification(type, data, input.sessionId));
          } catch {
            this.callbackThrew = true;
          }
        };
        emit("step/start", { turn: 1, step: 1 });
        emit("tool/call", {
          turn: 1,
          step: 1,
          callId: "broken",
          name: "write_stage4_proof",
          arguments: JSON.stringify({ content: input.prompt }),
        });
        const digest = createHash("sha256")
          .update(`stage5-proof-v1\0${input.sessionId}\0broken`)
          .digest("hex");
        const partition = join(this.workspaceRoot, digest);
        await mkdir(partition, { mode: 0o700 });
        await writeFile(join(partition, "stage4-proof.txt"), input.prompt, { mode: 0o600 });
        emit("step/end", { turn: 1, step: 1 });
        return { finalResponse: "drained" };
      }
    }

    const runtime = new DrainingRuntime(await uniqueWorkspace("agui-draining-workspace-"));
    roots.push(runtime.workspaceRoot);
    const { store, coordinator } = await fixture(runtime);
    store.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    coordinator.admit({ runId: "r1", conversationId: "c1", prompt: "proof" });

    expect((await terminal(store, "r1")).status).toBe("failed");
    expect(runtime.emitted).toBe(3);
    expect(runtime.callbackThrew).toBe(false);
    expect(store.listEvents("r1", 0, 100).filter((row) => row.channel === "raw-dsh")).toHaveLength(
      3,
    );
    expect(
      store
        .listEvents("r1", 0, 100)
        .filter((row) => row.channel === "ag-ui")
        .map((row) => row.type),
    ).toEqual(["RUN_STARTED", "STEP_STARTED", "RUN_ERROR"]);
    await coordinator.whenIdle();
    expect(store.listArtifacts("r1")).toHaveLength(1);
    expect(await readdir(runtime.workspaceRoot)).toEqual([]);
    store.close();
  });

  test("treats a raw authority write failure as execution unknown while continuing raw attempts", async () => {
    class RawFailureRuntime extends BaseRuntime {
      override async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
        input.onNotification(notification("step/start", { turn: 1, step: 1 }, input.sessionId));
        const callId = "raw-failed-call";
        input.onNotification(
          notification(
            "assistant/message",
            {
              turn: 1,
              step: 1,
              message: {
                content: [
                  {
                    type: "tool-call",
                    id: callId,
                    name: "write_stage4_proof",
                    arguments: JSON.stringify({ content: input.prompt }),
                  },
                ],
              },
            },
            input.sessionId,
          ),
        );
        input.onNotification({
          method: "session.event",
          params: {
            sessionId: input.sessionId,
            event: {
              type: "tool/call",
              seq: 3,
              time: 0,
              data: {
                turn: 1,
                step: 1,
                callId,
                name: "write_stage4_proof",
                arguments: JSON.stringify({ content: input.prompt }),
              },
              rawFailure: 1n,
            },
          } as never,
        });
        const digest = createHash("sha256")
          .update(`stage5-proof-v1\0${input.sessionId}\0${callId}`)
          .digest("hex");
        const partition = join(this.workspaceRoot, digest);
        await mkdir(partition, { mode: 0o700 });
        await writeFile(join(partition, "stage4-proof.txt"), input.prompt, { mode: 0o600 });
        input.onNotification(notification("step/end", { turn: 1, step: 1 }, input.sessionId));
        return { finalResponse: "drained" };
      }
    }
    const runtime = new RawFailureRuntime(await uniqueWorkspace("agui-raw-failure-"));
    roots.push(runtime.workspaceRoot);
    const { store, coordinator } = await fixture(runtime);
    store.createConversation({ id: "c1", title: "Raw", dshSessionRef: "raw-session" });
    coordinator.admit({ runId: "raw-run", conversationId: "c1", prompt: "proof" });
    expect((await terminal(store, "raw-run")).status).toBe("execution_unknown");
    expect(store.getConversation("c1")?.recoveryState).toBe("blocked");
    expect(
      store.listEvents("raw-run", 0, 100).filter((row) => row.channel === "raw-dsh"),
    ).toHaveLength(3);
    expect(store.listArtifacts("raw-run")).toHaveLength(1);
    expect(await readdir(runtime.workspaceRoot)).toEqual([]);
    await coordinator.whenIdle();
    await coordinator.close();
    store.close();
  });

  test("settles only coordinator-owned active runs unknown after shared runtime loss", async () => {
    class ConcurrentRuntime extends BaseRuntime {
      override async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
        this.activeRuns += 1;
        try {
          if (input.sessionId === "session-1") {
            await new Promise((resolve) => setTimeout(resolve, 10));
            throw new RuntimeTransportUncertainError();
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
          const callId = "safe-call";
          input.onNotification(notification("step/start", { turn: 1, step: 1 }, input.sessionId));
          input.onNotification(
            notification(
              "assistant/message",
              {
                turn: 1,
                step: 1,
                message: {
                  content: [
                    {
                      type: "tool-call",
                      id: callId,
                      name: "write_stage4_proof",
                      arguments: JSON.stringify({ content: input.prompt }),
                    },
                  ],
                },
              },
              input.sessionId,
            ),
          );
          input.onNotification(
            notification(
              "tool/call",
              {
                turn: 1,
                step: 1,
                callId,
                name: "write_stage4_proof",
                arguments: JSON.stringify({ content: input.prompt }),
              },
              input.sessionId,
            ),
          );
          const digest = createHash("sha256")
            .update(`stage5-proof-v1\0${input.sessionId}\0${callId}`)
            .digest("hex");
          const partition = join(this.workspaceRoot, digest);
          await mkdir(partition, { mode: 0o700 });
          await writeFile(join(partition, "stage4-proof.txt"), input.prompt, { mode: 0o600 });
          input.onNotification(
            notification(
              "tool/result",
              {
                turn: 1,
                step: 1,
                message: {
                  content: [
                    { type: "tool-result", toolCallId: callId, content: [], isError: false },
                  ],
                },
              },
              input.sessionId,
            ),
          );
          input.onNotification(notification("step/end", { turn: 1, step: 1 }, input.sessionId));
          return { finalResponse: "safe" };
        } finally {
          this.activeRuns -= 1;
        }
      }
    }

    const runtime = new ConcurrentRuntime(await uniqueWorkspace("agui-concurrent-workspace-"));
    roots.push(runtime.workspaceRoot);
    const { store, coordinator } = await fixture(runtime);
    store.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    store.createConversation({ id: "c2", title: "Two", dshSessionRef: "session-2" });
    store.createConversation({ id: "c3", title: "External", dshSessionRef: "session-3" });
    store.createConversation({ id: "c4", title: "Pending", dshSessionRef: "session-4" });
    store.admitRun({ id: "external", conversationId: "c3", request: { message: "external" } });
    store.startRun("external");
    coordinator.admit({ runId: "r1", conversationId: "c1", prompt: "uncertain" });
    coordinator.admit({ runId: "r2", conversationId: "c2", prompt: "safe" });
    coordinator.admit({ runId: "r3", conversationId: "c4", prompt: "pending" });

    expect((await terminal(store, "r1")).status).toBe("execution_unknown");
    expect((await terminal(store, "r2")).status).toBe("execution_unknown");
    expect(store.getRun("external")?.status).toBe("running");
    expect(store.getConversation("c1")?.recoveryState).toBe("blocked");
    expect(store.getConversation("c2")?.recoveryState).toBe("blocked");
    expect(store.getConversation("c3")?.recoveryState).toBe("active");
    await coordinator.whenIdle();
    expect(store.getRun("r3")?.status).toBe("queued");
    const r2Events = store.listEvents("r2", 0, 100);
    const r2Agui = r2Events.filter((row) => row.channel === "ag-ui");
    expect(r2Agui.at(-1)?.type).toBe("RUN_ERROR");
    expect(r2Events.some((row) => row.channel === "raw-dsh" && row.seq > r2Agui.at(-1)!.seq)).toBe(
      true,
    );
    expect(store.listArtifacts("r2")).toHaveLength(1);
    expect(await readdir(runtime.workspaceRoot)).toEqual([]);
    await coordinator.restartRuntime();
    expect((await terminal(store, "r3")).status).toBe("succeeded");
    await coordinator.whenIdle();
    store.close();
  });

  test("integrates failed startup ownership with shared-loss queue pause and restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "agui-startup-integration-"));
    roots.push(root);
    const source = join(root, "source");
    const plugin = join(root, "plugin");
    await mkdir(join(source, "packages/examples/jsonrpc-demo/lib"), { recursive: true });
    await mkdir(join(source, "node_modules/.pnpm/node_modules"), { recursive: true });
    await mkdir(join(plugin, "dist/plugins"), { recursive: true });
    await writeFile(join(source, "packages/examples/jsonrpc-demo/lib/bin.js"), "// built\n");
    await writeFile(join(plugin, "dist/plugins/tool.js"), "export const name='tool'\n");
    await writeFile(join(plugin, "dist/plugins/listener.js"), "export const name='listener'\n");
    const adapterPath = join(root, "sdk-resume-adapter.js");
    await writeFile(adapterPath, "export const name='fixture-resume-adapter'\n");
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({ name: "fixture", type: "module" }),
    );
    const evidence: SourceEvidence = {
      root: source,
      revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
      binPath: join(source, "packages/examples/jsonrpc-demo/lib/bin.js"),
      hostNodeModules: join(source, "node_modules/.pnpm/node_modules"),
      async revalidate() {},
      testOnlyAllowPluginRoot: true,
      testOnlyAdapterPath: adapterPath,
    };
    let factories = 0;
    let allowClose = false;
    const factory: HarnessFactory = (options) => {
      factories += 1;
      const index = factories;
      return {
        async start() {
          await writeFile(
            options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
            '["write_stage4_proof"]\n',
          );
          if (index === 1) throw new Error("handshake failed");
        },
        async run(prompt, runOptions) {
          const callId = `recovered-${runOptions.sessionId}`;
          const emit = (type: string, data: unknown) =>
            runOptions.onNotification(notification(type, data, runOptions.sessionId));
          emit("step/start", { turn: 1, step: 1 });
          emit("assistant/message", {
            turn: 1,
            step: 1,
            message: {
              content: [
                {
                  type: "tool-call",
                  id: callId,
                  name: "write_stage4_proof",
                  arguments: JSON.stringify({ content: prompt }),
                },
              ],
            },
          });
          emit("tool/call", {
            turn: 1,
            step: 1,
            callId,
            name: "write_stage4_proof",
            arguments: JSON.stringify({ content: prompt }),
          });
          const digest = createHash("sha256")
            .update(`stage5-proof-v1\0${runOptions.sessionId}\0${callId}`)
            .digest("hex");
          const partition = join(options.launch.env!.DSH_CWD!, digest);
          await mkdir(partition, { mode: 0o700 });
          await writeFile(join(partition, "stage4-proof.txt"), prompt, { mode: 0o600 });
          emit("tool/result", {
            turn: 1,
            step: 1,
            message: {
              content: [{ type: "tool-result", toolCallId: callId, content: [], isError: false }],
            },
          });
          emit("step/end", { turn: 1, step: 1 });
          return { finalResponse: "recovered" };
        },
        async close() {
          if (index === 1 && !allowClose) throw new Error("attempted process still alive");
        },
      };
    };
    const manager = await SourceRuntimeManager.create({
      sourceRoot: source,
      appStateRoot: join(root, "app-state"),
      generationParent: join(root, "generations"),
      pluginRoot: plugin,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => evidence,
      testOnlyHarnessFactory: factory,
    });
    const store = new AuthoritativeStore(join(root, "app.db"));
    const coordinator = new RunCoordinator(store, manager);
    coordinators.set(store, coordinator);
    for (let index = 1; index <= 3; index += 1) {
      store.createConversation({
        id: `start-c${index}`,
        title: `Start ${index}`,
        dshSessionRef: `start-session-${index}`,
      });
      coordinator.admit({
        runId: `start-r${index}`,
        conversationId: `start-c${index}`,
        prompt: `proof-${index}`,
      });
    }
    expect((await terminal(store, "start-r1")).status).toBe("execution_unknown");
    expect((await terminal(store, "start-r2")).status).toBe("execution_unknown");
    expect(store.getRun("start-r3")?.status).toBe("queued");
    expect(factories).toBe(1);
    allowClose = true;
    await coordinator.restartRuntime();
    expect((await terminal(store, "start-r3")).status).toBe("succeeded");
    expect(factories).toBe(2);
    await coordinator.close();
    await manager.cleanupPersistentState();
    store.close();
  });

  test("does not trust artifact bytes returned by a runtime", async () => {
    class UntrustedArtifactRuntime extends BaseRuntime {
      override async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
        input.onNotification(notification("step/start", { turn: 1, step: 1 }, input.sessionId));
        input.onNotification(notification("step/end", { turn: 1, step: 1 }, input.sessionId));
        return {
          finalResponse: "claimed",
          artifact: {
            filename: "stage4-proof.txt",
            mediaType: "text/plain",
            bytes: Buffer.from("forged"),
          },
        };
      }
    }

    const runtime = new UntrustedArtifactRuntime(
      await uniqueWorkspace("agui-untrusted-workspace-"),
    );
    roots.push(runtime.workspaceRoot);
    const { store, coordinator } = await fixture(runtime);
    store.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
    coordinator.admit({ runId: "r1", conversationId: "c1", prompt: "expected proof" });

    expect((await terminal(store, "r1")).status).toBe("failed");
    expect(store.listArtifacts("r1")).toEqual([]);
    store.close();
  });

  test("limits different conversations to two concurrent runtime calls", async () => {
    class MeasuringRuntime extends FakeDshRuntime {
      maxActive = 0;

      override run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
        const result = super.run(input);
        this.maxActive = Math.max(this.maxActive, this.activeRuns);
        return result;
      }
    }

    const workspace = await uniqueWorkspace("agui-measuring-workspace-");
    roots.push(workspace);
    const runtime = new MeasuringRuntime(workspace);
    runtime.delayMs = 40;
    const { store, coordinator } = await fixture(runtime);
    for (let index = 1; index <= 3; index += 1) {
      store.createConversation({
        id: `c${index}`,
        title: `Conversation ${index}`,
        dshSessionRef: `session-${index}`,
      });
      coordinator.admit({
        runId: `r${index}`,
        conversationId: `c${index}`,
        prompt: `proof-${index}`,
      });
    }
    await expect(coordinator.restartRuntime()).rejects.toThrow(/active runs/);
    await Promise.all([terminal(store, "r1"), terminal(store, "r2"), terminal(store, "r3")]);
    expect(runtime.maxActive).toBe(2);
    expect(await readdir(workspace)).toEqual([]);
    store.close();
  });

  test.each(["symlink", "wrong-mode"] as const)(
    "rejects a %s proof before snapshot",
    async (kind) => {
      class UnsafeProofRuntime extends BaseRuntime {
        override async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
          const callId = `unsafe-${kind}`;
          input.onNotification(notification("step/start", { turn: 1, step: 1 }, input.sessionId));
          input.onNotification(
            notification(
              "tool/call",
              {
                turn: 1,
                step: 1,
                callId,
                name: "write_stage4_proof",
                arguments: JSON.stringify({ content: input.prompt }),
              },
              input.sessionId,
            ),
          );
          const digest = createHash("sha256")
            .update(`stage5-proof-v1\0${input.sessionId}\0${callId}`)
            .digest("hex");
          const partition = join(this.workspaceRoot, digest);
          await mkdir(partition, { mode: 0o700 });
          const proof = join(partition, "stage4-proof.txt");
          if (kind === "symlink") {
            const foreign = join(this.workspaceRoot, "foreign.txt");
            await writeFile(foreign, input.prompt, { mode: 0o600 });
            await symlink(foreign, proof);
          } else {
            await writeFile(proof, input.prompt, { mode: 0o600 });
            await chmod(proof, 0o644);
          }
          input.onNotification(
            notification(
              "tool/result",
              {
                turn: 1,
                step: 1,
                message: {
                  content: [
                    { type: "tool-result", toolCallId: callId, content: [], isError: false },
                  ],
                },
              },
              input.sessionId,
            ),
          );
          input.onNotification(notification("step/end", { turn: 1, step: 1 }, input.sessionId));
          return { finalResponse: "unsafe" };
        }
      }
      const workspace = await uniqueWorkspace(`agui-unsafe-${kind}-`);
      roots.push(workspace);
      const runtime = new UnsafeProofRuntime(workspace);
      const { store, coordinator } = await fixture(runtime);
      store.createConversation({ id: "c1", title: "Unsafe", dshSessionRef: "unsafe-session" });
      coordinator.admit({ runId: "unsafe-run", conversationId: "c1", prompt: "proof" });
      expect((await terminal(store, "unsafe-run")).status).toBe("failed");
      expect(store.listArtifacts("unsafe-run")).toEqual([]);
      await coordinator.whenIdle();
      expect((await readdir(workspace)).sort()).toEqual(kind === "symlink" ? ["foreign.txt"] : []);
      await coordinator.close();
      store.close();
    },
  );

  test("snapshots proof bytes but refuses to delete a partition containing a foreign entry", async () => {
    class ForeignEntryRuntime extends BaseRuntime {
      override async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
        const callId = "foreign-call";
        input.onNotification(notification("step/start", { turn: 1, step: 1 }, input.sessionId));
        input.onNotification(
          notification(
            "assistant/message",
            {
              turn: 1,
              step: 1,
              message: {
                content: [
                  {
                    type: "tool-call",
                    id: callId,
                    name: "write_stage4_proof",
                    arguments: JSON.stringify({ content: input.prompt }),
                  },
                ],
              },
            },
            input.sessionId,
          ),
        );
        input.onNotification(
          notification(
            "tool/call",
            {
              turn: 1,
              step: 1,
              callId,
              name: "write_stage4_proof",
              arguments: JSON.stringify({ content: input.prompt }),
            },
            input.sessionId,
          ),
        );
        const digest = createHash("sha256")
          .update(`stage5-proof-v1\0${input.sessionId}\0${callId}`)
          .digest("hex");
        const partition = join(this.workspaceRoot, digest);
        await mkdir(partition, { mode: 0o700 });
        await writeFile(join(partition, "stage4-proof.txt"), input.prompt, { mode: 0o600 });
        await writeFile(join(partition, "foreign.keep"), "foreign", { mode: 0o600 });
        input.onNotification(
          notification(
            "tool/result",
            {
              turn: 1,
              step: 1,
              message: {
                content: [{ type: "tool-result", toolCallId: callId, content: [], isError: false }],
              },
            },
            input.sessionId,
          ),
        );
        input.onNotification(notification("step/end", { turn: 1, step: 1 }, input.sessionId));
        return { finalResponse: "foreign" };
      }
    }
    const workspace = await uniqueWorkspace("agui-foreign-entry-");
    roots.push(workspace);
    const runtime = new ForeignEntryRuntime(workspace);
    const { store, coordinator } = await fixture(runtime);
    store.createConversation({ id: "c1", title: "Foreign", dshSessionRef: "foreign-session" });
    coordinator.admit({ runId: "foreign-run", conversationId: "c1", prompt: "proof" });
    expect((await terminal(store, "foreign-run")).status).toBe("failed");
    await coordinator.whenIdle();
    expect(store.listArtifacts("foreign-run")).toHaveLength(1);
    const partitions = await readdir(workspace);
    expect(partitions).toHaveLength(1);
    expect((await readdir(join(workspace, partitions[0]!))).sort()).toEqual([
      "foreign.keep",
      "stage4-proof.txt",
    ]);
    expect(() =>
      coordinator.admit({ runId: "later", conversationId: "c1", prompt: "later" }),
    ).toThrow(/coordinator is unavailable/);
    await coordinator.close();
    store.close();
  });

  test("a run deadline drains the original operation without closing the shared runtime", async () => {
    class DeadlineRuntime extends FakeDshRuntime {
      closeCalls = 0;

      override async close(): Promise<void> {
        this.closeCalls += 1;
        await super.close();
      }
    }
    const workspace = await uniqueWorkspace("agui-deadline-workspace-");
    roots.push(workspace);
    const runtime = new DeadlineRuntime(workspace);
    runtime.delayMs = 40;
    const root = await mkdtemp(join(tmpdir(), "agui-deadline-"));
    roots.push(root);
    const store = new AuthoritativeStore(join(root, "app.db"));
    store.createConversation({ id: "c1", title: "Deadline", dshSessionRef: "deadline-session" });
    const coordinator = new RunCoordinator(store, runtime, { runDeadlineMs: 10 });
    coordinators.set(store, coordinator);
    coordinator.admit({ runId: "deadline-run", conversationId: "c1", prompt: "deadline proof" });

    expect((await terminal(store, "deadline-run")).status).toBe("failed");
    await coordinator.whenIdle();
    expect(runtime.activeRuns).toBe(0);
    expect(runtime.closeCalls).toBe(0);
    expect(store.listArtifacts("deadline-run")).toHaveLength(1);
    expect(await readdir(workspace)).toEqual([]);
    await coordinator.close();
    expect(runtime.closeCalls).toBe(1);
    store.close();
  });

  test("latches a terminal write failure, settles unknown and stops new admission", async () => {
    const workspace = await uniqueWorkspace("agui-terminal-write-");
    roots.push(workspace);
    const runtime = new FakeDshRuntime(workspace);
    runtime.failNext = "known";
    const { store, coordinator } = await fixture(runtime);
    store.createConversation({ id: "c1", title: "Terminal", dshSessionRef: "terminal-session" });
    const originalFinish = store.finishRun.bind(store);
    Object.defineProperty(store, "finishRun", {
      configurable: true,
      value: (...arguments_: Parameters<AuthoritativeStore["finishRun"]>) => {
        if (arguments_[0] === "fatal-run") throw new Error("terminal storage unavailable");
        return originalFinish(...arguments_);
      },
    });
    coordinator.admit({ runId: "fatal-run", conversationId: "c1", prompt: "proof" });
    expect((await terminal(store, "fatal-run")).status).toBe("execution_unknown");
    await coordinator.whenIdle();
    expect(() =>
      coordinator.admit({ runId: "later", conversationId: "c1", prompt: "later" }),
    ).toThrow(/coordinator is unavailable/);
    await coordinator.close();
    store.close();
  });

  test("quarantines the only proof copy when Artifact persistence fails", async () => {
    const workspace = await uniqueWorkspace("agui-artifact-quarantine-");
    roots.push(workspace);
    const runtime = new FakeDshRuntime(workspace);
    const { store, coordinator } = await fixture(runtime);
    store.createConversation({ id: "c1", title: "Artifact", dshSessionRef: "artifact-session" });
    Object.defineProperty(store, "saveArtifact", {
      configurable: true,
      value: () => {
        throw new Error("artifact database unavailable");
      },
    });
    coordinator.admit({ runId: "artifact-run", conversationId: "c1", prompt: "only proof" });
    expect((await terminal(store, "artifact-run")).status).toBe("execution_unknown");
    expect(store.listArtifacts("artifact-run")).toEqual([]);
    const partitions = await readdir(workspace);
    expect(partitions).toHaveLength(1);
    expect(await readFile(join(workspace, partitions[0]!, "stage4-proof.txt"), "utf8")).toBe(
      "only proof",
    );
    expect(() =>
      coordinator.admit({ runId: "later", conversationId: "c1", prompt: "later" }),
    ).toThrow(/coordinator is unavailable/);
    await coordinator.close();
    store.close();
  });
});

test("an aborted persisted subscription releases its waiter without a notification", async () => {
  const root = await mkdtemp(join(tmpdir(), "agui-subscription-"));
  roots.push(root);
  const store = new AuthoritativeStore(join(root, "app.db"));
  store.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
  store.admitRun({ id: "r1", conversationId: "c1", request: { message: "wait" } });
  const subscriptions = new PersistedSubscriptions(store);
  const controller = new AbortController();
  const iterator = subscriptions.stream("r1", 1, undefined, controller.signal);
  const pending = iterator.next();
  controller.abort();
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  expect(subscriptions.activeSubscribers).toBe(0);
  store.close();
});

test("subscription shutdown aborts every iterator without changing a queued Run", async () => {
  const root = await mkdtemp(join(tmpdir(), "agui-subscription-shutdown-"));
  roots.push(root);
  const store = new AuthoritativeStore(join(root, "app.db"));
  store.createConversation({ id: "c1", title: "One", dshSessionRef: "session-1" });
  store.admitRun({ id: "r1", conversationId: "c1", request: { message: "wait" } });
  const subscriptions = new PersistedSubscriptions(store);
  const first = subscriptions.stream("r1", 1);
  const second = subscriptions.stream("r1", 1);
  const pending = Promise.all([first.next(), second.next()]);
  while (subscriptions.activeSubscribers !== 2)
    await new Promise((resolve) => setImmediate(resolve));
  subscriptions.shutdown();
  await expect(pending).resolves.toEqual([
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
  expect(subscriptions.activeSubscribers).toBe(0);
  expect(store.getRun("r1")?.status).toBe("queued");
  store.close();
});

test("a real HttpAgent consumes exact EventEncoder frames over an ephemeral socket", async () => {
  const workspace = await uniqueWorkspace("agui-http-workspace-");
  roots.push(workspace);
  const runtime = new FakeDshRuntime(workspace);
  const { store, coordinator } = await fixture(runtime);
  store.createConversation({ id: "http-thread", title: "HTTP", dshSessionRef: "http-session" });
  const app = createServer({ store, coordinator });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const events: BaseEvent[] = [];
  const agent = new HttpAgent({
    url: `${address}/api/ag-ui`,
    threadId: "http-thread",
    initialMessages: [{ id: "user-1", role: "user", content: "socket proof" }],
  });

  const result = await agent.runAgent(
    { runId: "http-run" },
    {
      onEvent: ({ event }) => {
        events.push(event);
      },
    },
  );

  expect(result.newMessages).toMatchObject([
    { role: "assistant", content: "done", toolCalls: [{ id: "fake-http-session-1-1" }] },
    { role: "tool", toolCallId: "fake-http-session-1-1" },
  ]);
  expect(events.map((event) => event.type)).toEqual([
    EventType.RUN_STARTED,
    EventType.STEP_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
    EventType.TEXT_MESSAGE_END,
    EventType.TOOL_CALL_START,
    EventType.TOOL_CALL_ARGS,
    EventType.TOOL_CALL_END,
    EventType.TOOL_CALL_RESULT,
    EventType.STEP_FINISHED,
    EventType.RUN_FINISHED,
  ]);
  expect(store.getRun("http-run")?.status).toBe("succeeded");
  expect(store.getArtifact(store.listArtifacts("http-run")[0]!.id)?.bytes.toString()).toBe(
    "socket proof",
  );
  await coordinator.close();
  await app.close();
  store.close();
});

test("two sequential Runs in one Conversation hydrate unique assistant messages and tool calls", async () => {
  const workspace = await uniqueWorkspace("agui-multiturn-workspace-");
  roots.push(workspace);
  const runtime = new FakeDshRuntime(workspace);
  const { store, coordinator } = await fixture(runtime);
  store.createConversation({
    id: "multiturn-thread",
    title: "Multi-turn",
    dshSessionRef: "multiturn-session",
  });
  const app = createServer({ store, coordinator });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const agent = new HttpAgent({
    url: `${address}/api/ag-ui`,
    threadId: "multiturn-thread",
    initialMessages: [{ id: "user-1", role: "user", content: "first proof" }],
  });
  await agent.runAgent({ runId: "multiturn-run-1" });
  agent.addMessage({ id: "user-2", role: "user", content: "second proof" });
  await agent.runAgent({ runId: "multiturn-run-2" });

  const snapshot = (await (
    await fetch(`${address}/api/conversations/multiturn-thread`)
  ).json()) as {
    messages: Array<{
      id: string;
      role: string;
      toolCalls?: Array<{ id: string }>;
    }>;
  };
  const assistants = snapshot.messages.filter((message) => message.role === "assistant");

  expect(snapshot.messages).toHaveLength(6);
  expect(new Set(snapshot.messages.map((message) => message.id)).size).toBe(6);
  expect(assistants).toHaveLength(2);
  expect(new Set(assistants.map((message) => message.id)).size).toBe(2);
  expect(
    new Set(assistants.flatMap((message) => message.toolCalls?.map((call) => call.id) ?? [])).size,
  ).toBe(2);

  await coordinator.close();
  await app.close();
  store.close();
});

test("disconnect detaches the AG-UI subscriber while the authoritative run continues", async () => {
  const workspace = await uniqueWorkspace("agui-disconnect-workspace-");
  roots.push(workspace);
  const runtime = new FakeDshRuntime(workspace);
  runtime.delayMs = 120;
  const { store, coordinator } = await fixture(runtime);
  store.createConversation({
    id: "detach-thread",
    title: "Detach",
    dshSessionRef: "detach-session",
  });
  const app = createServer({ store, coordinator });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const controller = new AbortController();
  const response = await fetch(`${address}/api/ag-ui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "detach-thread",
      runId: "detach-run",
      state: {},
      messages: [{ id: "detach-user", role: "user", content: "detached proof" }],
      tools: [],
      context: [],
    }),
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  await response.body!.getReader().read();
  controller.abort();
  const detachDeadline = Date.now() + 500;
  while (coordinator.subscriptions.activeSubscribers !== 0 && Date.now() < detachDeadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(coordinator.subscriptions.activeSubscribers).toBe(0);
  expect(store.getRun("detach-run")?.status).toBe("running");
  expect((await terminal(store, "detach-run")).status).toBe("succeeded");
  await coordinator.whenIdle();
  await coordinator.close();
  await app.close();
  store.close();
});

test("HTTP validation, duplicate metadata, artifact download and business cursor replay are bounded", async () => {
  const workspace = await uniqueWorkspace("agui-api-workspace-");
  roots.push(workspace);
  const runtime = new FakeDshRuntime(workspace);
  const { store, coordinator } = await fixture(runtime);
  store.createConversation({ id: "api-thread", title: "API", dshSessionRef: "api-session" });
  const app = createServer({ store, coordinator });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });

  await expect((await fetch(`${address}/api/capabilities`)).json()).resolves.toMatchObject({
    wireCancel: false,
    approval: false,
    localOnly: true,
    devDirectAgent: true,
  });
  const health = (await (await fetch(`${address}/api/health`)).json()) as Record<string, unknown>;
  expect(health).toMatchObject({ status: "last-observed", runtimeGeneration: 1, activeRuns: 0 });
  expect(health).not.toHaveProperty("pid");

  const unsupported = await fetch(`${address}/api/ag-ui`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "not json",
  });
  expect(unsupported.status).toBe(415);
  const invalid = await fetch(`${address}/api/ag-ui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "api-thread" }),
  });
  expect(invalid.status).toBe(400);

  const agent = new HttpAgent({
    url: `${address}/api/ag-ui`,
    threadId: "api-thread",
    initialMessages: [{ id: "api-user", role: "user", content: "api proof" }],
  });
  await agent.runAgent({ runId: "api-run" });
  const snapshot = (await (await fetch(`${address}/api/conversations/api-thread`)).json()) as {
    conversation: { id: string };
    messages: Array<{ role: string; content?: string; toolCallId?: string }>;
    runs: Array<{ id: string }>;
  };
  expect(snapshot.conversation.id).toBe("api-thread");
  expect(snapshot.runs).toMatchObject([{ id: "api-run" }]);
  expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  expect(snapshot.messages[0]?.content).toBe("api proof");
  const duplicate = await fetch(`${address}/api/ag-ui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: "api-thread",
      runId: "api-run",
      state: {},
      messages: [{ id: "api-user", role: "user", content: "api proof" }],
      tools: [],
      context: [],
    }),
  });
  expect(duplicate.status).toBe(409);
  await expect(duplicate.json()).resolves.toMatchObject({
    run: "/api/runs/api-run",
    replay: "/api/runs/api-run/stream",
  });

  const all = store.listEvents("api-run", 0, 100);
  const after = all[3]!.seq;
  const expected = all.filter((row) => row.seq > after).map((row) => row.seq);
  const queryReplay = await (
    await fetch(`${address}/api/runs/api-run/stream?after=${after}`)
  ).text();
  expect([...queryReplay.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual(
    expected,
  );
  const headerReplay = await (
    await fetch(`${address}/api/runs/api-run/stream`, {
      headers: { "last-event-id": String(after) },
    })
  ).text();
  expect([...headerReplay.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]))).toEqual(
    expected,
  );
  const badCursor = await fetch(`${address}/api/runs/api-run/stream?after=NaN`);
  expect(badCursor.status).toBe(400);
  expect((await fetch(`${address}/api/runs/api-run/events?after=NaN`)).status).toBe(400);
  expect((await fetch(`${address}/api/runs/missing/events`)).status).toBe(404);

  const artifact = store.listArtifacts("api-run")[0]!;
  const download = await fetch(`${address}/api/artifacts/${artifact.id}`);
  expect(download.headers.get("content-type")).toContain("text/plain");
  expect(download.headers.get("content-disposition")).toBe(
    'attachment; filename="stage4-proof.txt"',
  );
  expect(await download.text()).toBe("api proof");
  await coordinator.close();
  await app.close();
  store.close();
});

test("the unauthenticated server rejects non-loopback peers", async () => {
  const workspace = await uniqueWorkspace("agui-guard-workspace-");
  roots.push(workspace);
  const runtime = new FakeDshRuntime(workspace);
  const { store, coordinator } = await fixture(runtime);
  const app = createServer({ store, coordinator });
  await expect(listenLocal(app, { host: "0.0.0.0", port: 0 })).rejects.toThrow(/loopback/);
  const response = await app.inject({
    method: "GET",
    url: "/api/health",
    remoteAddress: "203.0.113.8",
  });
  expect(response.statusCode).toBe(403);
  await app.close();
  await coordinator.close();
  store.close();
});

test("server shutdown is bounded and marks a never-settling active run unknown", async () => {
  class NeverSettlingRuntime extends BaseRuntime {
    shutdownCalls = 0;
    private rejectRun: ((error: Error) => void) | undefined;

    override async run(): Promise<RuntimeRunResult> {
      this.activeRuns += 1;
      try {
        return await new Promise<RuntimeRunResult>((_resolve, reject) => {
          this.rejectRun = reject;
        });
      } finally {
        this.activeRuns -= 1;
      }
    }

    override async shutdown(): Promise<void> {
      this.shutdownCalls += 1;
      this.rejectRun?.(new RuntimeTransportUncertainError("forced shutdown"));
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const workspace = await uniqueWorkspace("agui-never-");
  roots.push(workspace);
  const runtime = new NeverSettlingRuntime(workspace);
  const { store, coordinator } = await fixture(runtime);
  store.createConversation({ id: "never-c", title: "Never", dshSessionRef: "never-session" });
  coordinator.admit({ runId: "never-r", conversationId: "never-c", prompt: "never" });
  const app = createServer({ store, coordinator, shutdownGraceMs: 20 });
  await app.ready();
  const outcome = await Promise.race([
    app.close().then(() => "closed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
  ]);
  expect(outcome).toBe("closed");
  expect(runtime.shutdownCalls).toBe(1);
  expect(store.getRun("never-r")?.status).toBe("execution_unknown");
  expect(store.getConversation("never-c")?.recoveryState).toBe("blocked");
  store.close();
});

test("conversation hydration pages through more than ten thousand persisted events", async () => {
  const root = await mkdtemp(join(tmpdir(), "agui-hydration-pages-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const store = new AuthoritativeStore(join(root, "app.db"));
  store.createConversation({ id: "hydrate-c", title: "Hydrate", dshSessionRef: "hydrate-session" });
  store.admitRun({ id: "hydrate-r", conversationId: "hydrate-c", request: { message: "input" } });
  store.startRun("hydrate-r");
  store.appendEvent("hydrate-r", "ag-ui", "TEXT_MESSAGE_START", {
    type: "TEXT_MESSAGE_START",
    messageId: "long-message",
    role: "assistant",
  });
  store.testOnlyAppendRepeatedEvent("hydrate-r", 10_005, "ag-ui", "TEXT_MESSAGE_CONTENT", {
    type: "TEXT_MESSAGE_CONTENT",
    messageId: "long-message",
    delta: "x",
  });
  store.appendEvent("hydrate-r", "ag-ui", "TEXT_MESSAGE_END", {
    type: "TEXT_MESSAGE_END",
    messageId: "long-message",
  });
  store.finishRun("hydrate-r", "succeeded");
  const coordinator = new RunCoordinator(store, new BaseRuntime(workspace));
  const app = createServer({ store, coordinator });
  const response = await app.inject({ method: "GET", url: "/api/conversations/hydrate-c" });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { messages: Array<{ role: string; content?: string }> };
  expect(body.messages.find((message) => message.role === "assistant")?.content).toHaveLength(
    10_005,
  );
  await app.close();
  store.close();
});

test("app close aborts more-than-concurrency SSE sockets while pending Runs stay queued", async () => {
  class MultiSocketRuntime extends BaseRuntime {
    private readonly rejects = new Set<(error: Error) => void>();

    override async run(): Promise<RuntimeRunResult> {
      this.activeRuns += 1;
      try {
        return await new Promise<RuntimeRunResult>((_resolve, reject) => {
          this.rejects.add(reject);
        });
      } finally {
        this.activeRuns -= 1;
      }
    }

    override async shutdown(): Promise<void> {
      const error = new RuntimeTransportUncertainError("socket test shutdown");
      for (const reject of this.rejects) reject(error);
      this.rejects.clear();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  const workspace = await mkdtemp(join(tmpdir(), "agui-multi-socket-workspace-"));
  roots.push(workspace);
  const runtime = new MultiSocketRuntime(workspace);
  const { store, coordinator } = await fixture(runtime);
  for (let index = 1; index <= 4; index += 1)
    store.createConversation({
      id: `socket-c${index}`,
      title: `Socket ${index}`,
      dshSessionRef: `socket-session-${index}`,
    });
  const app = createServer({ store, coordinator, shutdownGraceMs: 20 });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const requests = Array.from({ length: 4 }, (_, offset) => {
    const index = offset + 1;
    return fetch(`${address}/api/ag-ui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: `socket-c${index}`,
        runId: `socket-r${index}`,
        state: {},
        messages: [{ id: `socket-user-${index}`, role: "user", content: `proof-${index}` }],
        tools: [],
        context: [],
      }),
    });
  });
  const subscriberDeadline = Date.now() + 1_000;
  while (coordinator.subscriptions.activeSubscribers !== 4 && Date.now() < subscriberDeadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(coordinator.subscriptions.activeSubscribers).toBe(4);
  const closeOutcome = await Promise.race([
    app.close().then(() => "closed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 500)),
  ]);
  expect(closeOutcome).toBe("closed");
  await Promise.allSettled(requests);
  expect(coordinator.subscriptions.activeSubscribers).toBe(0);
  expect(store.getRun("socket-r1")?.status).toBe("execution_unknown");
  expect(store.getRun("socket-r2")?.status).toBe("execution_unknown");
  expect(store.getRun("socket-r3")?.status).toBe("queued");
  expect(store.getRun("socket-r4")?.status).toBe("queued");
  store.close();
});
