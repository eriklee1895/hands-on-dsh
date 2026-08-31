import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeepSeekHarness,
  HarnessClient,
  JsonRpcResponseError,
  RequestTimeoutError,
  SdkProtocolError,
  TransportClosedError,
  type HarnessNotification,
} from "@deepseek-ai/dsh-sdk-client";
import { afterEach, describe, expect, test } from "vitest";
import { runLowLevelPrompt } from "../src/low-level-run.ts";
import { NotificationProjection } from "../src/notification-projection.ts";
import { withOwnerDeadline } from "../src/owner-deadline.ts";

const temporaryRoots: string[] = [];
const fakeRuntime = join(import.meta.dirname, "fixtures/fake-runtime.mjs");

async function fakeOptions(mode = "normal") {
  const state = await mkdtemp(join(tmpdir(), "dsh-ts-fake-"));
  temporaryRoots.push(state);
  return {
    command: process.execPath,
    args: [fakeRuntime],
    cwd: state,
    env: { PATH: process.env.PATH, FAKE_DSH_MODE: mode, FAKE_DSH_STATE: state },
    requestTimeoutMs: 500,
    shutdownTimeoutMs: 100,
    disposeEofGraceMs: 50,
    disposeGraceMs: 100,
  };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for fake-runtime evidence: ${path}`);
}

async function waitForProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch {
      return;
    }
  }
  throw new Error(`fake runtime process ${pid} did not exit`);
}

function projectedText(notification: HarnessNotification): string | undefined {
  if (notification.method !== "session.event") return undefined;
  const event = notification.params.event as Record<string, unknown> | undefined;
  const data = event?.data as Record<string, unknown> | undefined;
  if (event?.type === "assistant/chunk") {
    const chunk = data?.chunk as Record<string, unknown> | undefined;
    return chunk?.type === "text-delta" && typeof chunk.text === "string" ? chunk.text : undefined;
  }
  if (event?.type !== "assistant/message") return undefined;
  const message = data?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("published SDK against the rc.2 fake runtime", () => {
  test("starts lazily, reuses one process, and preserves two-turn session memory", async () => {
    const options = await fakeOptions();
    const harness = new DeepSeekHarness({ launch: options });
    await expect(access(join(options.cwd, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
    const session = harness.session("memory-session");
    const first = await session.run("Remember amber.");
    const pid = await readFile(join(options.cwd, "pid"), "utf8");
    const second = await session.run("What did I ask you to remember?");
    expect(first.finalResponse).toBe("remembered: amber");
    expect(second.finalResponse).toBe("memory: amber");
    expect(
      first.events.filter((event) => event.type === "turn/start").map((event) => event.data.turn),
    ).toEqual([1]);
    expect(
      second.events.filter((event) => event.type === "turn/start").map((event) => event.data.turn),
    ).toEqual([2]);
    expect(await readFile(join(options.cwd, "pid"), "utf8")).toBe(pid);
    await harness.close();
    await harness.close();
    await waitForProcessGone(Number(pid));
  });

  test("matches initialize, prompt, receipt-before-response, notification, and shutdown frames", async () => {
    const options = await fakeOptions();
    const client = new HarnessClient(options);
    const initialized = await client.initialize({
      cwd: options.cwd,
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
    expect(initialized.serverInfo).toEqual({
      name: "deepseek-harness-sdk-runtime",
      version: "0.0.1",
    });
    const result = await runLowLevelPrompt(client, "parity", "hello");
    const sessionEvents = result.notifications
      .filter((notification) => notification.method === "session.event")
      .map((notification) => notification.params.event);
    expect(sessionEvents).toEqual([
      {
        type: "agent/inbox/spliced",
        seq: 0,
        time: 0,
        data: {
          target: "next-turn",
          start: 0,
          inserted: [
            {
              id: result.messageId,
              role: "user",
              content: [{ type: "text", text: "hello" }],
              source: { kind: "user" },
            },
          ],
        },
      },
      { type: "turn/start", seq: 1, time: 0, data: { turn: 1 } },
      {
        type: "agent/inbox/spliced",
        seq: 2,
        time: 0,
        data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] },
      },
      { type: "step/start", seq: 3, time: 0, data: { turn: 1, step: 1 } },
      {
        type: "user/message",
        seq: 4,
        time: 0,
        surfaceOp: "append",
        data: {
          id: result.messageId,
          role: "user",
          content: [{ type: "text", text: "hello" }],
          source: { kind: "user" },
        },
      },
      {
        type: "assistant/chunk",
        seq: 5,
        time: 0,
        data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "ok" } },
      },
      {
        type: "assistant/message",
        seq: 6,
        time: 0,
        surfaceOp: "append",
        sourceEventSeqs: [5],
        data: {
          turn: 1,
          step: 1,
          message: {
            id: "fake-assistant-parity-1-1",
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            source: { kind: "model", provider: "fake", model: "fake" },
          },
        },
      },
      { type: "step/end", seq: 7, time: 0, data: { turn: 1, step: 1 } },
      {
        type: "turn/end",
        seq: 8,
        time: 0,
        data: { turn: 1, reason: { kind: "completed" } },
      },
    ]);
    await client.close();
    const frames = (await readFile(join(options.cwd, "requests.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(frames.map((frame) => [frame.method, frame.params])).toEqual([
      [
        "initialize",
        { cwd: options.cwd, provider: "deepseek-official", model: "deepseek-v4-flash" },
      ],
      ["session/prompt", { sessionId: "parity", contentBlocks: [{ type: "text", text: "hello" }] }],
      ["shutdown", {}],
    ]);
  });

  test("projects only root text while retaining tool, subagent, and lifecycle counters", () => {
    const projection = new NotificationProjection("root");
    const notifications: HarnessNotification[] = [
      {
        method: "session.event",
        params: {
          sessionId: "child",
          event: {
            type: "assistant/chunk",
            data: { chunk: { type: "text-delta", index: 0, text: "child secret" } },
          },
        },
      },
      {
        method: "session.event",
        params: {
          sessionId: "root",
          event: {
            type: "assistant/chunk",
            data: { chunk: { type: "text-delta", index: 0, text: "root streamed" } },
          },
        },
      },
      {
        method: "session.event",
        params: {
          sessionId: "root",
          event: {
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "committed duplicate" }] } },
          },
        },
      },
      {
        method: "session.event",
        params: { sessionId: "root", event: { type: "tool/call", data: {} } },
      },
      {
        method: "session.event",
        params: { sessionId: "root", event: { type: "tool/result", data: {} } },
      },
      { method: "subagent.started", params: { parentSessionId: "root", childSessionId: "child" } },
      { method: "subagent.finished", params: { parentSessionId: "root", childSessionId: "child" } },
      { method: "session.status", params: { sessionId: "root", status: "running" } },
      { method: "session.status", params: { sessionId: "root", status: "idle" } },
    ];
    for (const notification of notifications) projection.accept(notification);
    expect(projection.snapshot()).toEqual({
      rootText: "root streamed",
      toolCalls: 1,
      toolResults: 1,
      subagentsStarted: 1,
      subagentsFinished: 1,
      running: 1,
      idle: 1,
    });
  });

  test("verifies exact external proof bytes created by the fake tool path", async () => {
    const options = await fakeOptions();
    const proof = join(options.cwd, "proof.txt");
    const expected = Buffer.from("exact proof bytes\n", "utf8");
    const harness = new DeepSeekHarness({ launch: options });
    const result = await harness.run(`WRITE_FILE:${proof}:${expected.toString("base64")}`, {
      sessionId: "tool",
    });
    expect(result.finalResponse).toBe("proof created");
    expect(await readFile(proof)).toEqual(expected);
    const toolRequestMessage = result.events.find(
      (event) => event.type === "assistant/message" && event.data.step === 1,
    );
    const completionMessage = result.events.find(
      (event) => event.type === "assistant/message" && event.data.step === 2,
    );
    const call = result.events.find((event) => event.type === "tool/call");
    const toolResult = result.events.find((event) => event.type === "tool/result");
    expect(toolRequestMessage).toMatchObject({
      surfaceOp: "append",
      sourceEventSeqs: [5, 6],
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "fake-assistant-tool-1-1",
          role: "assistant",
          source: { kind: "model", provider: "fake", model: "fake" },
          content: [
            { type: "text", text: "writing proof" },
            {
              type: "tool-call",
              id: "fake-write-file-call",
              name: "write-file",
              arguments: JSON.stringify({
                path: proof,
                contentBase64: expected.toString("base64"),
              }),
            },
          ],
        },
      },
    });
    expect(call).toMatchObject({
      data: {
        turn: 1,
        step: 1,
        callId: "fake-write-file-call",
        name: "write-file",
        arguments: JSON.stringify({ path: proof, contentBase64: expected.toString("base64") }),
      },
    });
    expect(toolResult).toMatchObject({
      surfaceOp: "append",
      sourceEventSeqs: [call?.seq],
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "fake-tool-result-tool-1-1",
          role: "user",
          source: { kind: "tool", callId: "fake-write-file-call" },
          content: [
            {
              type: "tool-result",
              toolCallId: "fake-write-file-call",
              content: [{ type: "text", text: "wrote proof file" }],
              isError: false,
            },
          ],
        },
      },
    });
    expect(completionMessage).toMatchObject({
      sourceEventSeqs: [12],
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 2,
        message: {
          id: "fake-assistant-tool-1-2",
          content: [{ type: "text", text: "proof created" }],
        },
      },
    });
    await harness.close();
  });
});

describe("receipt-to-idle and failures", () => {
  test("ignores every pre-receipt notification, descendants, and foreign roots", async () => {
    const options = await fakeOptions("noisy");
    const client = new HarnessClient(options);
    await client.initialize({
      cwd: options.cwd,
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
    const result = await runLowLevelPrompt(client, "root", "hello");
    expect(result.finalResponse).toBe("post receipt root");
    expect(result.observedRootEvents).toEqual(["post receipt root"]);
    const textNotifications = result.notifications
      .map((notification) => ({
        sessionId: notification.params.sessionId,
        text: projectedText(notification),
      }))
      .filter((entry): entry is { sessionId: unknown; text: string } => entry.text !== undefined);
    expect(textNotifications).toEqual([
      { sessionId: "root-child", text: "post receipt child" },
      { sessionId: "root-child", text: "post receipt child" },
      { sessionId: "root", text: "post receipt root" },
      { sessionId: "root", text: "post receipt root" },
    ]);
    expect(
      result.notifications.some((notification) => notification.params.sessionId === "foreign"),
    ).toBe(false);
    expect(
      result.notifications.map((notification) => [
        notification.method,
        notification.params.sessionId,
      ]),
    ).toEqual([
      ["session.event", "root"],
      ["session.status", "root"],
      ...Array.from({ length: 9 }, () => ["session.event", "root-child"]),
      ...Array.from({ length: 8 }, () => ["session.event", "root"]),
      ["session.status", "root"],
    ]);
    expect(
      result.notifications.some(
        (notification) =>
          notification.method === "subagent.started" || notification.method === "subagent.finished",
      ),
    ).toBe(false);
    expect(result.finalResponse).not.toContain("child");
    const eventSequences = new Map<string, number[]>();
    for (const notification of result.notifications) {
      if (notification.method !== "session.event") continue;
      const sessionId = notification.params.sessionId;
      const event = notification.params.event as { seq?: unknown };
      if (typeof sessionId !== "string" || typeof event.seq !== "number") continue;
      const values = eventSequences.get(sessionId) ?? [];
      values.push(event.seq);
      eventSequences.set(sessionId, values);
    }
    for (const values of eventSequences.values()) {
      expect(values.every((seq, index) => index === 0 || seq === values[index - 1]! + 1)).toBe(
        true,
      );
    }
    await client.close();
  });

  test("outer deadline closes the owner because the wire has no cancellation", async () => {
    const options = await fakeOptions("timeout");
    const client = new HarnessClient({ ...options, requestTimeoutMs: undefined });
    await expect(
      withOwnerDeadline("hung turn", 50, client, async () => {
        await client.initialize({
          cwd: options.cwd,
          provider: "deepseek-official",
          model: "deepseek-v4-flash",
        });
        return runLowLevelPrompt(client, "root", "hang");
      }),
    ).rejects.toThrow(/hung turn.*50ms/);
    await expect(client.request("initialize")).rejects.toBeInstanceOf(TransportClosedError);
  });

  test.each([
    ["error", JsonRpcResponseError],
    ["malformed", SdkProtocolError],
    ["eof", TransportClosedError],
  ])("surfaces typed %s failure", async (mode, errorType) => {
    const options = await fakeOptions(mode);
    const client = new HarnessClient(options);
    await client.initialize({
      cwd: options.cwd,
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
    await expect(client.prompt("root", [{ type: "text", text: "hello" }])).rejects.toBeInstanceOf(
      errorType,
    );
    await client.close();
  });

  test("surfaces a typed request timeout and reaps an uncooperative runtime idempotently", async () => {
    const options = await fakeOptions("forced");
    const client = new HarnessClient({ ...options, requestTimeoutMs: 25 });
    client.start();
    await waitForFile(join(options.cwd, "pid"));
    await expect(
      client.initialize({
        cwd: options.cwd,
        provider: "deepseek-official",
        model: "deepseek-v4-flash",
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    const pid = Number(await readFile(join(options.cwd, "pid"), "utf8"));
    await client.close();
    await client.close();
    expect(() => process.kill(pid, 0)).toThrow();
  });
});
