import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { CallId, createToolResultMessage } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, test } from "vitest";
import * as listenerPlugin from "../src/plugins/listener.ts";
import * as toolPlugin from "../src/plugins/tool.ts";
import type { ProofFileSystem } from "../src/plugins/tool.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function toolContext(): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  return ctx;
}

describe("proof tool boundary", () => {
  test("invalid config fails before registration", async () => {
    const ctx = await toolContext();
    const missing = await Promise.resolve(ctx.plugin(toolPlugin, {} as never)).then(
      () => undefined,
      (error) => error,
    );
    expect(missing).toBeDefined();
    expect(ctx.tools.get("write_stage4_proof")).toBeUndefined();
    const relative = await Promise.resolve(
      ctx.plugin(toolPlugin, { workspaceRoot: "relative" }),
    ).then(
      () => undefined,
      (error) => error,
    );
    expect(relative).toBeDefined();
    expect(ctx.tools.get("write_stage4_proof")).toBeUndefined();
    await ctx.fiber.dispose();
  });

  test.each(["post-create-abort", "open-failure", "write-failure", "close-failure"] as const)(
    "removes its exact partial artifact after %s",
    async (failure) => {
      const abort = new AbortController();
      const calls: string[] = [];
      const fs: ProofFileSystem = {
        async prepareRoot(path) {
          calls.push(`root:${path}`);
          return path;
        },
        async createPartition(path) {
          calls.push(`partition:${path}`);
        },
        async open(path) {
          calls.push(`open:${path}`);
          if (failure === "open-failure") throw new Error("open failed");
          return {
            async writeFile() {
              calls.push("write");
              if (failure === "post-create-abort") abort.abort(new Error("abort after create"));
              if (failure === "write-failure") throw new Error("write failed");
            },
            async close() {
              calls.push("close");
              if (failure === "close-failure") throw new Error("close failed");
            },
          };
        },
        async rm(path) {
          calls.push(`rm:${path}`);
        },
        async removePartition(path) {
          calls.push(`rmdir:${path}`);
        },
      };
      const tool = toolPlugin.createProofTool(
        {
          workspaceRoot: "/stage4-workspace",
          partitionMode: "call",
        },
        fs,
      );
      await expect(
        tool.execute({ content: "proof" }, {
          signal: abort.signal,
          callId: "failure-call",
          agent: { session: { id: "failure-session" } },
        } as never),
      ).rejects.toThrow(
        /abort after create|open failed|write failed|close failed|proof attempt cleanup failed/,
      );
      expect(calls[0]).toBe("root:/stage4-workspace");
      expect(calls[1]).toMatch(/^partition:\/stage4-workspace\/[a-f0-9]{64}$/);
      expect(calls[2]).toMatch(/^open:\/stage4-workspace\/[a-f0-9]{64}\/stage4-proof\.txt$/);
      if (failure !== "open-failure") {
        expect(calls).toContain("write");
        expect(calls.filter((call) => call === "close")).toHaveLength(
          failure === "close-failure" ? 2 : 1,
        );
        expect(calls.some((call) => call.startsWith("rm:/stage4-workspace/"))).toBe(true);
      }
      expect(calls.at(-1)).toMatch(/^rmdir:\/stage4-workspace\/[a-f0-9]{64}$/);
    },
  );

  test("pre-aborted exclusive execution creates no partial artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "stage4-cancel-"));
    roots.push(root);
    const ctx = await toolContext();
    await ctx.plugin(toolPlugin, { workspaceRoot: root });
    expect(ctx.tools.get("write_stage4_proof")?.isConcurrencySafe).toBeUndefined();
    const abort = new AbortController();
    abort.abort(new Error("cancel before create"));
    await expect(
      ctx.tools.execute({
        callId: CallId("cancel-call"),
        name: "write_stage4_proof",
        arguments: { content: "must not exist" },
        signal: abort.signal,
      }),
    ).resolves.toMatchObject({
      isError: true,
      error: { info: { code: "ABORTED_BEFORE_DISPATCH" } },
    });
    await expect(access(join(root, "stage4-proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await ctx.fiber.dispose();
  });

  test("call partition hashes session and call identities without exposing raw IDs", async () => {
    const opened: string[] = [];
    const fs: ProofFileSystem = {
      async prepareRoot(path) {
        return path;
      },
      async createPartition() {},
      async open(path) {
        opened.push(path);
        return { async writeFile() {}, async close() {} };
      },
      async rm() {},
      async removePartition() {},
    };
    const tool = toolPlugin.createProofTool(
      {
        workspaceRoot: "/workspace",
        partitionMode: "call",
      },
      fs,
    );
    const execute = (sessionId: string, callId: string) =>
      tool.execute({ content: "proof" }, {
        signal: new AbortController().signal,
        callId,
        agent: { session: { id: sessionId } },
      } as never);
    const first = await execute("session/raw-a", "same-call");
    const second = await execute("session/raw-b", "same-call");
    expect(opened).toHaveLength(2);
    expect(opened[0]).not.toBe(opened[1]);
    for (const path of opened) {
      expect(path).toMatch(/^\/workspace\/[a-f0-9]{64}\/stage4-proof\.txt$/);
      expect(path).not.toMatch(/raw|same-call/);
    }
    for (const value of [first, second]) {
      expect((value as { path: string }).path).not.toMatch(/raw|same-call/);
    }
    await expect(
      tool.execute({ content: "proof" }, {
        signal: new AbortController().signal,
        callId: "missing-agent",
      } as never),
    ).rejects.toThrow(/requires an Agent/);
  });

  test("real call partitions reject symlink roots, unsafe modes and collisions", async () => {
    const parent = await mkdtemp(join(tmpdir(), "stage5-partition-real-"));
    roots.push(parent);
    const unsafe = join(parent, "unsafe");
    await mkdir(unsafe, { mode: 0o755 });
    await chmod(unsafe, 0o755);
    const execute = (workspaceRoot: string) =>
      toolPlugin
        .createProofTool({
          workspaceRoot,
          partitionMode: "call",
        })
        .execute({ content: "proof" }, {
          signal: new AbortController().signal,
          callId: "call",
          agent: { session: { id: "session" } },
        } as never);
    await expect(execute(unsafe)).rejects.toThrow(/0700/);
    const target = join(parent, "target");
    await mkdir(target, { mode: 0o700 });
    const link = join(parent, "link");
    await symlink(target, link, "dir");
    await expect(execute(link)).rejects.toThrow(/real directory/);
    const safe = join(parent, "safe");
    await mkdir(safe, { mode: 0o700 });
    await execute(safe);
    await expect(execute(safe)).rejects.toThrow(/EEXIST/);
  });

  test("call partition abort after directory creation removes only its empty partition", async () => {
    const abort = new AbortController();
    const calls: string[] = [];
    const fs: ProofFileSystem = {
      async prepareRoot(path) {
        return path;
      },
      async createPartition(path) {
        calls.push(`partition:${path}`);
        abort.abort(new Error("abort after partition"));
      },
      async open(path) {
        calls.push(`open:${path}`);
        throw new Error("open must not run");
      },
      async rm(path) {
        calls.push(`rm:${path}`);
      },
      async removePartition(path) {
        calls.push(`rmdir:${path}`);
      },
    };
    const tool = toolPlugin.createProofTool(
      { workspaceRoot: "/workspace", partitionMode: "call" },
      fs,
    );
    await expect(
      tool.execute({ content: "proof" }, {
        signal: abort.signal,
        callId: "call",
        agent: { session: { id: "session" } },
      } as never),
    ).rejects.toThrow(/abort after partition/);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^partition:\/workspace\/[a-f0-9]{64}$/);
    expect(calls[1]).toMatch(/^rmdir:\/workspace\/[a-f0-9]{64}$/);
  });
});

describe("listener correlation boundary", () => {
  test("audit append failures leave live/durable state retryable and emit health evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "stage5-listener-retry-"));
    roots.push(root);
    const auditPath = join(root, "audit.jsonl");
    const healthPath = join(root, "health.jsonl");
    const ctx = await toolContext();
    await ctx.plugin(SessionStore);
    await ctx.plugin(listenerPlugin, {
      rootSessionId: "retry-root",
      toolName: "write_stage4_proof",
      auditPath,
      healthPath,
      auditOwnerToken: "retry-owner",
    });
    const session = ctx.sessions.create(SessionId("retry-root"));
    const agent = { session };
    const result = { content: [{ type: "text", text: "ok" }], isError: false };
    const emitLive = () =>
      ctx.emit(
        "tools/result",
        { name: "write_stage4_proof", callId: CallId("retry-call"), agent } as never,
        result as never,
      );
    await chmod(auditPath, 0o400);
    emitLive();
    await chmod(auditPath, 0o600);
    emitLive();
    await chmod(auditPath, 0o400);
    const event = session.append(
      "tool/result",
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: CallId("retry-call"),
          content: [{ type: "text", text: "ok" }],
          isError: false,
        }),
      },
      { surfaceOp: "append" },
    );
    await chmod(auditPath, 0o600);
    ctx.emit("session/event", session, event);
    expect(
      (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      {
        kind: "live",
        sessionId: "retry-root",
        toolName: "write_stage4_proof",
        callId: "retry-call",
      },
      {
        kind: "durable",
        sessionId: "retry-root",
        toolName: "write_stage4_proof",
        callId: "retry-call",
      },
    ]);
    expect(
      (await readFile(healthPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toMatchObject([
      { reason: "audit-append-failed", sessionId: "retry-root", callId: "retry-call" },
      { reason: "audit-append-failed", sessionId: "retry-root", callId: "retry-call" },
    ]);
    await ctx.fiber.dispose();
  });

  test("all-session mode correlates concurrent sessions and sequential pairs independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "stage5-listener-all-"));
    roots.push(root);
    const auditPath = join(root, "audit.jsonl");
    const healthPath = join(root, "health.jsonl");
    const ctx = await toolContext();
    await ctx.plugin(SessionStore);
    await ctx.plugin(listenerPlugin, {
      sessionMode: "all",
      toolName: "write_stage4_proof",
      auditPath,
      auditOwnerToken: "all-owner",
      healthPath,
    });
    const sessions = [ctx.sessions.create(SessionId("s1")), ctx.sessions.create(SessionId("s2"))];
    const result = { content: [{ type: "text", text: "ok" }], isError: false };
    const live = (index: number, callId: string) =>
      ctx.emit(
        "tools/result",
        {
          name: "write_stage4_proof",
          callId: CallId(callId),
          agent: { session: sessions[index] },
        } as never,
        result as never,
      );
    const durable = (index: number, callId: string) =>
      sessions[index]!.append(
        "tool/result",
        {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: CallId(callId),
            content: [{ type: "text", text: "ok" }],
            isError: false,
          }),
        },
        { surfaceOp: "append" },
      );
    durable(0, "before-live");
    live(0, "a");
    live(0, "a-duplicate");
    live(1, "b");
    durable(1, "b");
    durable(0, "a");
    live(0, "c");
    durable(0, "c");
    expect(
      (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { kind: "live", sessionId: "s1", toolName: "write_stage4_proof", callId: "a" },
      { kind: "live", sessionId: "s2", toolName: "write_stage4_proof", callId: "b" },
      { kind: "durable", sessionId: "s2", toolName: "write_stage4_proof", callId: "b" },
      { kind: "durable", sessionId: "s1", toolName: "write_stage4_proof", callId: "a" },
      { kind: "live", sessionId: "s1", toolName: "write_stage4_proof", callId: "c" },
      { kind: "durable", sessionId: "s1", toolName: "write_stage4_proof", callId: "c" },
    ]);
    expect(
      (await readFile(healthPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toMatchObject([
      { reason: "durable-without-matching-live", sessionId: "s1", callId: "before-live" },
      { reason: "duplicate-or-concurrent-live", sessionId: "s1", callId: "a-duplicate" },
    ]);
    await ctx.fiber.dispose();
  });

  test("validates routing and exclusively owns a 0600 audit before listeners", async () => {
    const root = await mkdtemp(join(tmpdir(), "stage4-listener-config-"));
    roots.push(root);
    const ctx = await toolContext();
    for (const config of [
      {
        rootSessionId: "",
        toolName: "write_stage4_proof",
        auditPath: join(root, "a"),
        auditOwnerToken: "owner",
      },
      { rootSessionId: "root", toolName: "", auditPath: join(root, "b"), auditOwnerToken: "owner" },
      {
        rootSessionId: "root",
        toolName: "write_stage4_proof",
        auditPath: "relative",
        auditOwnerToken: "owner",
      },
      {
        rootSessionId: "root",
        toolName: "write_stage4_proof",
        auditPath: join(root, "missing", "c"),
        auditOwnerToken: "owner",
      },
      {
        sessionMode: "all" as const,
        toolName: "write_stage4_proof",
        auditPath: join(root, "all-no-health"),
        auditOwnerToken: "owner",
      },
      {
        sessionMode: "all" as const,
        toolName: "write_stage4_proof",
        auditPath: join(root, "same"),
        healthPath: join(root, "same"),
        auditOwnerToken: "owner",
      },
    ]) {
      await expect(ctx.plugin(listenerPlugin, config)).rejects.toThrow();
    }
    const partialAudit = join(root, "partial-audit");
    await expect(
      ctx.plugin(listenerPlugin, {
        sessionMode: "all",
        toolName: "write_stage4_proof",
        auditPath: partialAudit,
        healthPath: join(root, "missing-health-parent", "health"),
        auditOwnerToken: "owner",
      }),
    ).rejects.toThrow();
    await expect(access(partialAudit)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(`${partialAudit}.owner`)).rejects.toMatchObject({ code: "ENOENT" });
    const owned = join(root, "owned.jsonl");
    const listener = ctx.plugin(listenerPlugin, {
      rootSessionId: "root",
      toolName: "write_stage4_proof",
      auditPath: owned,
      auditOwnerToken: "owner",
    });
    await listener;
    expect((await stat(owned)).mode & 0o777).toBe(0o600);
    await listener.dispose();
    expect((await stat(`${owned}.owner`)).mode & 0o777).toBe(0o600);
    await expect(
      ctx.plugin(listenerPlugin, {
        rootSessionId: "root",
        toolName: "write_stage4_proof",
        auditPath: owned,
        auditOwnerToken: "wrong-owner",
      }),
    ).rejects.toThrow(/owner token mismatch/);
    const remounted = ctx.plugin(listenerPlugin, {
      rootSessionId: "root",
      toolName: "write_stage4_proof",
      auditPath: owned,
      auditOwnerToken: "owner",
    });
    await remounted;
    await remounted.dispose();
    await ctx.fiber.dispose();
  });

  test("accepts first matching live/durable pair and rejects all mismatches and duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "stage4-listener-"));
    roots.push(root);
    const auditPath = join(root, "audit.jsonl");
    const ctx = await toolContext();
    await ctx.plugin(SessionStore);
    const listener = ctx.plugin(listenerPlugin, {
      rootSessionId: "root",
      toolName: "write_stage4_proof",
      auditPath,
      auditOwnerToken: "correlation-owner",
    });
    await listener;
    const rootSession = ctx.sessions.create(SessionId("root"));
    const foreignSession = ctx.sessions.create(SessionId("foreign"));
    const rootAgent = { session: rootSession };
    const foreignAgent = { session: foreignSession };
    const result = { content: [{ type: "text", text: "ok" }], isError: false };

    ctx.emit(
      "tools/result",
      { name: "other", callId: CallId("other"), agent: rootAgent } as never,
      result as never,
    );
    ctx.emit(
      "tools/result",
      { name: "write_stage4_proof", callId: CallId("foreign"), agent: foreignAgent } as never,
      result as never,
    );
    ctx.emit(
      "tools/result",
      { name: "write_stage4_proof", callId: CallId("accepted"), agent: rootAgent } as never,
      result as never,
    );
    ctx.emit(
      "tools/result",
      { name: "write_stage4_proof", callId: CallId("duplicate"), agent: rootAgent } as never,
      result as never,
    );

    const appendDurable = (session: typeof rootSession, callId: string) =>
      session.append(
        "tool/result",
        {
          turn: 1,
          step: 1,
          message: createToolResultMessage({
            callId: CallId(callId),
            content: [{ type: "text", text: "ok" }],
            isError: false,
          }),
        },
        { surfaceOp: "append" },
      );
    appendDurable(foreignSession, "accepted");
    appendDurable(rootSession, "mismatch");
    appendDurable(rootSession, "accepted");
    appendDurable(rootSession, "accepted");

    const expected = [
      { kind: "live", sessionId: "root", toolName: "write_stage4_proof", callId: "accepted" },
      { kind: "durable", sessionId: "root", toolName: "write_stage4_proof", callId: "accepted" },
    ];
    expect(
      (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(expected);
    await listener.dispose();
    ctx.emit(
      "tools/result",
      { name: "write_stage4_proof", callId: CallId("accepted"), agent: rootAgent } as never,
      result as never,
    );
    appendDurable(rootSession, "accepted");
    expect(
      (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual(expected);
    const listener2 = ctx.plugin(listenerPlugin, {
      rootSessionId: "root",
      toolName: "write_stage4_proof",
      auditPath,
      auditOwnerToken: "correlation-owner",
    });
    await listener2;
    ctx.emit(
      "tools/result",
      { name: "write_stage4_proof", callId: CallId("accepted-2"), agent: rootAgent } as never,
      result as never,
    );
    appendDurable(rootSession, "accepted-2");
    expect(
      (await readFile(auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      ...expected,
      { kind: "live", sessionId: "root", toolName: "write_stage4_proof", callId: "accepted-2" },
      { kind: "durable", sessionId: "root", toolName: "write_stage4_proof", callId: "accepted-2" },
    ]);
    await listener2.dispose();
    await ctx.fiber.dispose();
  });
});
