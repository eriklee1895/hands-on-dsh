import { describe, expect, test, vi } from "vitest";
import { ApiClient } from "../../src/web/api-client.ts";

const conversation = {
  id: "conversation-1",
  title: "First conversation",
  dshSessionRef: "dsh-conversation-1-g1",
  sessionGeneration: 1,
  recoveryState: "active",
};

const run = {
  id: "run-1",
  conversationId: conversation.id,
  admissionSeq: 1,
  request: { message: "proof" },
  fingerprint: "fingerprint",
  status: "succeeded",
  dshSessionRef: conversation.dshSessionRef,
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ApiClient", () => {
  test("validates every persisted application response used by the browser", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/conversations") return json([conversation]);
      if (path === `/api/conversations/${conversation.id}`)
        return json({
          conversation,
          messages: [{ id: "assistant-1", role: "assistant", content: "done" }],
          runs: [run],
        });
      if (path === `/api/runs/${run.id}`)
        return json({
          ...run,
          artifacts: [
            {
              id: "artifact-1",
              filename: "stage4-proof.txt",
              mediaType: "text/plain",
              size: 5,
              sha256: "a".repeat(64),
            },
          ],
          events: `/api/runs/${run.id}/events`,
        });
      if (path === `/api/runs/${run.id}/events?after=0&limit=500`)
        return json([
          {
            runId: run.id,
            seq: 1,
            channel: "business",
            type: "queued",
            payload: { request: { message: "proof" } },
            createdAt: 1,
          },
        ]);
      if (path === "/api/capabilities")
        return json({
          wireCancel: false,
          approval: false,
          localOnly: true,
          devDirectAgent: true,
          businessReplay: "/api/runs/:id/stream",
        });
      if (path === "/api/health")
        return json({ status: "last-observed", runtimeGeneration: 1, activeRuns: 0 });
      throw new Error(`unexpected request ${path}`);
    });
    const api = new ApiClient(fetcher);

    await expect(api.listConversations()).resolves.toEqual([conversation]);
    await expect(api.getConversation(conversation.id)).resolves.toMatchObject({
      conversation,
      messages: [{ role: "assistant", content: "done" }],
      runs: [run],
    });
    await expect(api.getRun(run.id)).resolves.toMatchObject({
      id: run.id,
      artifacts: [{ id: "artifact-1", size: 5 }],
    });
    await expect(api.listRunEvents(run.id, 0)).resolves.toMatchObject([
      { runId: run.id, seq: 1, channel: "business" },
    ]);
    await expect(api.getCapabilities()).resolves.toMatchObject({
      wireCancel: false,
      approval: false,
      devDirectAgent: true,
    });
    await expect(api.getHealth()).resolves.toEqual({
      status: "last-observed",
      runtimeGeneration: 1,
      activeRuns: 0,
    });
    expect(api.artifactUrl("artifact-1")).toBe("/api/artifacts/artifact-1");
  });

  test("rejects a malformed successful response instead of trusting server JSON", async () => {
    const api = new ApiClient(vi.fn(async () => json({ status: "healthy", activeRuns: "0" })));

    await expect(api.getHealth()).rejects.toThrow(/invalid response.*\/api\/health/i);
  });

  test("parses chunked business SSE and validates each persisted event", async () => {
    const encoder = new TextEncoder();
    const wire = encoder.encode(
      'id: 1\r\ndata: {"runId":"run-1","seq":1,"channel":"business","type":"running","payload":{"label":"运行"},"createdAt":1}\r\n\r\nid: 2\ndata: {"runId":"run-1","seq":2,"channel":"business","type":"succeeded","payload":{"status":"succeeded"},"createdAt":2}\n\n',
    );
    const unicodeBoundary = wire.indexOf(0xe8);
    const chunks = [
      wire.slice(0, unicodeBoundary + 1),
      wire.slice(unicodeBoundary + 1, unicodeBoundary + 2),
      wire.slice(unicodeBoundary + 2),
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const api = new ApiClient(
      vi.fn(
        async () =>
          new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      ),
    );
    const observed: number[] = [];

    await api.streamRunEvents("run-1", 0, new AbortController().signal, (event) => {
      observed.push(event.seq);
    });

    expect(observed).toEqual([1, 2]);
  });

  test("validates local mutations without attaching a browser credential", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBeUndefined();
      if (String(input) === "/api/conversations") {
        expect(init).toMatchObject({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: conversation.id, title: conversation.title }),
        });
        return json(conversation, 201);
      }
      if (String(input) === "/api/runtime/restart") {
        expect(init?.method).toBe("POST");
        return json({ generation: 2 });
      }
      if (String(input) === `/api/conversations/${conversation.id}/acknowledge`) {
        expect(init?.method).toBe("POST");
        return json({ ...conversation, recoveryState: "active", sessionGeneration: 2 });
      }
      throw new Error(`unexpected request ${String(input)}`);
    });
    const api = new ApiClient(fetcher);

    await expect(api.createConversation(conversation.id, conversation.title)).resolves.toEqual(
      conversation,
    );
    await expect(api.restartRuntime()).resolves.toEqual({ generation: 2 });
    await expect(api.acknowledgeUnknown(conversation.id)).resolves.toMatchObject({
      recoveryState: "active",
      sessionGeneration: 2,
    });
  });
});
