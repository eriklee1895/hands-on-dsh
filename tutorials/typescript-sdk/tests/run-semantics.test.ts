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
import { requireCompletedTurn, requireRememberedNonce } from "../src/run-outcome.ts";

const roots: string[] = [];
const fakeRuntime = join(import.meta.dirname, "fixtures/fake-runtime.mjs");

async function fakeOptions(mode = "normal") {
  const state = await mkdtemp(join(tmpdir(), "dsh-ts-fake-"));
  roots.push(state);
  return {
    dshBin: fakeRuntime,
    profile: "sdk-minimal",
    processCwd: state,
    dshHome: join(state, "home"),
    env: { PATH: process.env.PATH, FAKE_DSH_MODE: mode, FAKE_DSH_STATE: state },
    initializeTimeoutMs: 500,
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
  throw new Error(`timed out waiting for fake runtime: ${path}`);
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

function eventText(notification: HarnessNotification): string | undefined {
  if (notification.method !== "session.event") return undefined;
  const event = notification.params.event as {
    type?: string;
    data?: { message?: { content?: { type: string; text?: string }[] } };
  };
  if (event.type !== "assistant/message") return undefined;
  return event.data?.message?.content
    ?.filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("published SDK and public fake CLI", () => {
  test("rejects a resolved run when the final turn stopped at max tokens or error", () => {
    for (const kind of ["max-tokens", "error"]) {
      expect(() =>
        requireCompletedTurn([{ type: "turn/end", data: { reason: { kind } } }]),
      ).toThrow(/turn ended/);
    }
    expect(() => requireCompletedTurn([])).toThrow(/turn ended/);
    expect(() =>
      requireCompletedTurn([{ type: "turn/end", data: { reason: { kind: "completed" } } }]),
    ).not.toThrow();
  });

  test("rejects a second-turn answer that forgot the expected nonce", () => {
    expect(() => requireRememberedNonce(" SAFFRON\n", "SAFFRON")).not.toThrow();
    expect(() => requireRememberedNonce("chamber", "amber")).toThrow(/amber/);
    expect(() => requireRememberedNonce("memory: SAFFRON", "SAFFRON")).toThrow(/SAFFRON/);
  });
  test("starts lazily, reuses one process and one session for two turns, then reaps it", async () => {
    const options = await fakeOptions();
    const harness = new DeepSeekHarness({
      ...options,
      cwd: options.processCwd,
      model: "deepseek-flash",
    });
    await expect(access(join(options.processCwd, "pid"))).rejects.toMatchObject({ code: "ENOENT" });
    const session = harness.session("memory");
    try {
      const first = await session.run("Remember amber.");
      const pid = Number(await readFile(join(options.processCwd, "pid"), "utf8"));
      const second = await session.run("What did I ask you to remember?");
      expect(first.finalResponse).toBe("remembered: amber");
      expect(second.finalResponse).toBe("memory: amber");
      expect(
        first.events.filter((event) => event.type === "turn/start").map((event) => event.data.turn),
      ).toEqual([1]);
      expect(
        second.events
          .filter((event) => event.type === "turn/start")
          .map((event) => event.data.turn),
      ).toEqual([2]);
      expect(Number(await readFile(join(options.processCwd, "pid"), "utf8"))).toBe(pid);
      await harness.close();
      await waitForProcessGone(pid);
    } finally {
      await harness.close();
    }
  });

  test("a custom SAFFRON nonce survives two turns through the public SDK fake CLI", async () => {
    const options = await fakeOptions("nonce");
    const harness = new DeepSeekHarness({
      ...options,
      cwd: options.processCwd,
      model: "deepseek-flash",
    });
    try {
      const session = harness.session("custom-nonce");
      const first = await session.run("记住代号 SAFFRON，只用文字确认，不要调用工具。");
      requireCompletedTurn(first.events);
      const second = await session.run("刚才的代号是什么？只回答代号原文，不要调用工具。");
      requireCompletedTurn(second.events);
      expect(first.finalResponse).toBe("已记住");
      expect(second.finalResponse).toBe("SAFFRON");
      expect(() => requireRememberedNonce(second.finalResponse, "SAFFRON")).not.toThrow();
    } finally {
      await harness.close();
    }
  });

  test("accepts receipt before prompt response and settles at root idle", async () => {
    const options = await fakeOptions();
    const client = new HarnessClient(options);
    try {
      const identity = await client.initialize({
        cwd: options.processCwd,
        provider: "deepseek-official",
        model: "deepseek-flash",
      });
      expect(identity.serverInfo).toEqual({
        name: "deepseek-harness-sdk-runtime",
        version: "0.0.1",
      });
      const result = await runLowLevelPrompt(client, "root", "hello");
      expect(result.messageId).toMatch(/^message-/);
      expect(result.finalResponse).toBe("ok");
      expect(result.observedRootEvents).toEqual(["ok"]);
      const events = result.notifications
        .filter((n) => n.method === "session.event")
        .map((n) => n.params.event as { type: string });
      expect(events[0]?.type).toBe("agent/inbox/spliced");
      expect(events.map((event) => event.type)).toContain("assistant/message");
      expect(events.map((event) => event.type)).not.toContain("assistant/chunk");
      const requests = (await readFile(join(options.processCwd, "requests.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string });
      expect(requests.map((request) => request.method)).toEqual(["initialize", "session/prompt"]);
    } finally {
      await client.close();
    }
  });

  test("projects only the last committed root message, plus root tool and lifecycle counts", () => {
    const projection = new NotificationProjection("root");
    const notifications: HarnessNotification[] = [
      {
        method: "session.event",
        params: {
          sessionId: "root",
          event: { type: "assistant/message.stream", data: { chunk: { text: "partial" } } },
        },
      },
      {
        method: "session.event",
        params: {
          sessionId: "child",
          event: {
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "child" }] } },
          },
        },
      },
      {
        method: "session.event",
        params: {
          sessionId: "root",
          event: {
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "first" }] } },
          },
        },
      },
      {
        method: "session.event",
        params: {
          sessionId: "root",
          event: {
            type: "assistant/message",
            data: { message: { content: [{ type: "text", text: "last" }] } },
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
      rootText: "last",
      toolCalls: 1,
      toolResults: 1,
      subagentsStarted: 1,
      subagentsFinished: 1,
      running: 1,
      idle: 1,
    });
  });

  test("confirms fake tool side effect by exact external bytes", async () => {
    const options = await fakeOptions();
    const proof = join(options.processCwd, "proof.txt");
    const expected = Buffer.from("exact proof bytes\n", "utf8");
    const harness = new DeepSeekHarness({
      ...options,
      cwd: options.processCwd,
      model: "deepseek-flash",
    });
    try {
      const result = await harness.run(`WRITE_FILE:${proof}:${expected.toString("base64")}`, {
        sessionId: "tool",
      });
      expect(result.finalResponse).toBe("proof created");
      expect(await readFile(proof)).toEqual(expected);
      expect(result.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(["tool/call", "tool/result"]),
      );
      expect(result.events.filter((event) => event.type === "assistant/message")).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });

  test("filters pre-receipt, foreign, and child answers from the final root result", async () => {
    const options = await fakeOptions("noisy");
    const client = new HarnessClient(options);
    try {
      await client.initialize({
        cwd: options.processCwd,
        provider: "deepseek-official",
        model: "deepseek-flash",
      });
      const result = await runLowLevelPrompt(client, "root", "hello");
      expect(result.finalResponse).toBe("post receipt root");
      expect(result.observedRootEvents).toEqual(["post receipt root"]);
      expect(result.notifications.some((n) => n.params.sessionId === "foreign")).toBe(false);
      expect(
        result.notifications
          .filter((n) => n.method === "session.event")
          .map(eventText)
          .filter(Boolean),
      ).toEqual(["post receipt child", "post receipt root"]);
      expect(result.notifications.at(-1)).toMatchObject({
        method: "session.status",
        params: { sessionId: "root", status: "idle" },
      });
    } finally {
      await client.close();
    }
  });

  test("EOF during prompt rejects and the client closes", async () => {
    const options = await fakeOptions("eof");
    const client = new HarnessClient(options);
    try {
      await client.initialize({
        cwd: options.processCwd,
        provider: "deepseek-official",
        model: "deepseek-flash",
      });
      await expect(runLowLevelPrompt(client, "root", "hello")).rejects.toBeInstanceOf(
        TransportClosedError,
      );
    } finally {
      await client.close();
    }
  });

  test.each([
    ["error", JsonRpcResponseError],
    ["malformed", SdkProtocolError],
  ])("surfaces %s as a typed protocol failure", async (mode, errorType) => {
    const options = await fakeOptions(mode);
    const client = new HarnessClient(options);
    try {
      await client.initialize({
        cwd: options.processCwd,
        provider: "deepseek-official",
        model: "deepseek-flash",
      });
      await expect(client.prompt("root", [{ type: "text", text: "hello" }])).rejects.toBeInstanceOf(
        errorType,
      );
    } finally {
      await client.close();
    }
  });

  test("outer deadline closes a hung owner and request timeout reaps a forced runtime", async () => {
    const timeout = await fakeOptions("timeout");
    const first = new HarnessClient({ ...timeout, requestTimeoutMs: undefined });
    await expect(
      withOwnerDeadline("hung turn", 50, first, async () => {
        await first.initialize({
          cwd: timeout.processCwd,
          provider: "deepseek-official",
          model: "deepseek-flash",
        });
        return runLowLevelPrompt(first, "root", "hang");
      }),
    ).rejects.toThrow(/hung turn.*50ms/);
    await expect(first.request("initialize")).rejects.toBeInstanceOf(TransportClosedError);

    const forced = await fakeOptions("forced");
    const second = new HarnessClient({ ...forced, initializeTimeoutMs: 25 });
    second.start();
    await waitForFile(join(forced.processCwd, "pid"));
    await expect(
      second.initialize({
        cwd: forced.processCwd,
        provider: "deepseek-official",
        model: "deepseek-flash",
      }),
    ).rejects.toBeInstanceOf(RequestTimeoutError);
    const pid = Number(await readFile(join(forced.processCwd, "pid"), "utf8"));
    await second.close();
    await second.close();
    await waitForProcessGone(pid);
  });
});
