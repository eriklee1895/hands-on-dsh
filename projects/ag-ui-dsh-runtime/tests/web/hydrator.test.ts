import { HttpAgent } from "@ag-ui/client";
import { describe, expect, test, vi } from "vitest";
import {
  ConversationHydrator,
  type ConversationSnapshot,
} from "../../src/web/conversation-hydrator.ts";

function snapshot(id: string, content: string): ConversationSnapshot {
  return {
    conversation: {
      id,
      title: `Conversation ${id}`,
      dshSessionRef: `dsh-${id}-g1`,
      sessionGeneration: 1,
      recoveryState: "active",
    },
    messages: [{ id: `message-${id}`, role: "assistant", content }],
    runs: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("ConversationHydrator", () => {
  test("creates a fresh direct HttpAgent and hydrates it before publishing the selection", async () => {
    const firstSnapshot = snapshot("one", "persisted answer");
    const hydrator = new ConversationHydrator({
      fetchSnapshot: vi.fn(async () => firstSnapshot),
    });

    const first = await hydrator.select("one");
    const second = await hydrator.select("one");

    expect(first?.agent).toBeInstanceOf(HttpAgent);
    expect(first?.agent).not.toBe(second?.agent);
    expect(first?.agent).toMatchObject({ agentId: "dsh", threadId: "one" });
    expect(first?.agent.messages).toEqual(firstSnapshot.messages);
    expect(first?.snapshot).toBe(firstSnapshot);
  });

  test("aborts the previous selection and suppresses its stale response", async () => {
    const first = deferred<ConversationSnapshot>();
    const second = deferred<ConversationSnapshot>();
    const signals: AbortSignal[] = [];
    const createdFor: string[] = [];
    const hydrator = new ConversationHydrator({
      fetchSnapshot: vi.fn((conversationId, signal) => {
        signals.push(signal);
        return conversationId === "one" ? first.promise : second.promise;
      }),
      createAgent: (conversationId) => {
        createdFor.push(conversationId);
        return new HttpAgent({
          url: "/api/ag-ui",
          agentId: "dsh",
          threadId: conversationId,
        });
      },
    });

    const staleSelection = hydrator.select("one");
    const activeSelection = hydrator.select("two");
    second.resolve(snapshot("two", "second"));
    await expect(activeSelection).resolves.toMatchObject({
      snapshot: { conversation: { id: "two" } },
      agent: { threadId: "two" },
    });
    first.resolve(snapshot("one", "stale first"));

    await expect(staleSelection).resolves.toBeUndefined();
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
    expect(createdFor).toEqual(["two"]);
  });

  test("a stale rejection cannot replace the active selection or its fresh agent", async () => {
    const stale = deferred<ConversationSnapshot>();
    const active = snapshot("two", "active second");
    const hydrator = new ConversationHydrator({
      fetchSnapshot: vi.fn((conversationId) =>
        conversationId === "one" ? stale.promise : Promise.resolve(active),
      ),
    });

    const staleSelection = hydrator.select("one");
    const activeSelection = await hydrator.select("two");
    stale.reject(new Error("stale failure"));

    await expect(staleSelection).resolves.toBeUndefined();
    expect(activeSelection).toMatchObject({
      agent: { threadId: "two" },
      snapshot: { conversation: { id: "two" } },
    });
    const thirdSelection = await hydrator.select("two");
    expect(thirdSelection?.agent).not.toBe(activeSelection?.agent);
  });
});
