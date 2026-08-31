import { EventEncoder } from "@ag-ui/encoder";
import { RunAgentInputSchema } from "@ag-ui/core";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { RunCoordinator } from "./coordinator.js";
import type { AuthoritativeStore } from "./store.js";
import type { RunEvent } from "./store.js";

interface SnapshotMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content?: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

function* hydrationEvents(store: AuthoritativeStore, runId: string): Generator<RunEvent> {
  const highWater = store.getEventHighWater(runId);
  let after = 0;
  while (after < highWater) {
    const page = store.listEventsThrough(runId, after, 250, highWater);
    if (page.length === 0) return;
    yield* page;
    after = page.at(-1)!.seq;
  }
}

function conversationMessages(
  store: AuthoritativeStore,
  conversationId: string,
): SnapshotMessage[] {
  const messages: SnapshotMessage[] = [];
  for (const run of store.listRunsByConversation(conversationId)) {
    const request = run.request as { message?: unknown };
    if (typeof request.message === "string")
      messages.push({ id: `dsh-user-${run.id}`, role: "user", content: request.message });
    const assistants = new Map<string, SnapshotMessage>();
    for (const row of hydrationEvents(store, run.id)) {
      if (
        row.channel !== "ag-ui" ||
        typeof row.payload !== "object" ||
        row.payload === null ||
        Array.isArray(row.payload)
      )
        continue;
      const event = row.payload as Record<string, unknown>;
      if (event.type === "TEXT_MESSAGE_START" && typeof event.messageId === "string") {
        const assistant: SnapshotMessage = { id: event.messageId, role: "assistant", content: "" };
        assistants.set(event.messageId, assistant);
        messages.push(assistant);
      } else if (
        event.type === "TEXT_MESSAGE_CONTENT" &&
        typeof event.messageId === "string" &&
        typeof event.delta === "string"
      ) {
        const assistant = assistants.get(event.messageId);
        if (assistant !== undefined) assistant.content = `${assistant.content ?? ""}${event.delta}`;
      } else if (
        event.type === "TOOL_CALL_START" &&
        typeof event.parentMessageId === "string" &&
        typeof event.toolCallId === "string" &&
        typeof event.toolCallName === "string"
      ) {
        let assistant = assistants.get(event.parentMessageId);
        if (assistant === undefined) {
          assistant = { id: event.parentMessageId, role: "assistant" };
          assistants.set(event.parentMessageId, assistant);
          messages.push(assistant);
        }
        (assistant.toolCalls ??= []).push({
          id: event.toolCallId,
          type: "function",
          function: { name: event.toolCallName, arguments: "" },
        });
      } else if (
        event.type === "TOOL_CALL_ARGS" &&
        typeof event.toolCallId === "string" &&
        typeof event.delta === "string"
      ) {
        for (const assistant of assistants.values()) {
          const call = assistant.toolCalls?.find((candidate) => candidate.id === event.toolCallId);
          if (call !== undefined) call.function.arguments += event.delta;
        }
      } else if (
        event.type === "TOOL_CALL_RESULT" &&
        typeof event.messageId === "string" &&
        typeof event.toolCallId === "string" &&
        typeof event.content === "string"
      ) {
        messages.push({
          id: event.messageId,
          role: "tool",
          toolCallId: event.toolCallId,
          content: event.content,
        });
      }
    }
  }
  return messages;
}

function lastUserMessage(value: unknown): string {
  const parsed = RunAgentInputSchema.parse(value);
  const message = [...parsed.messages].reverse().find((candidate) => candidate.role === "user");
  if (message === undefined || typeof message.content !== "string")
    throw new Error("one string user message is required");
  return message.content;
}

export interface SseWritable {
  destroyed: boolean;
  writableEnded: boolean;
  write(chunk: string): boolean;
  once(event: string, listener: (...arguments_: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...arguments_: unknown[]) => void): unknown;
}

export async function writeSseChunk(
  raw: SseWritable,
  chunk: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted || raw.destroyed || raw.writableEnded) throw new Error("SSE socket is closed");
  if (raw.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      raw.removeListener("drain", drain);
      raw.removeListener("close", close);
      raw.removeListener("error", error);
      signal.removeEventListener("abort", close);
    };
    const drain = () => {
      cleanup();
      resolve();
    };
    const close = () => {
      cleanup();
      reject(new Error("SSE socket closed before drain"));
    };
    const error = (...arguments_: unknown[]) => {
      cleanup();
      const cause = arguments_[0];
      reject(cause instanceof Error ? cause : new Error("SSE socket error"));
    };
    raw.once("drain", drain);
    raw.once("close", close);
    raw.once("error", error);
    signal.addEventListener("abort", close, { once: true });
    if (signal.aborted || raw.destroyed || raw.writableEnded) close();
  });
}

function detachSignal(request: { raw: NodeJS.EventEmitter }, raw: SseWritable) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.raw.once("aborted", abort);
  raw.once("close", abort);
  return {
    signal: controller.signal,
    dispose() {
      request.raw.removeListener("aborted", abort);
      raw.removeListener("close", abort);
    },
  };
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

export async function listenLocal(
  app: FastifyInstance,
  options: { host?: string; port: number; allowInsecureRemote?: boolean },
): Promise<string> {
  const host = options.host ?? "127.0.0.1";
  if (
    options.allowInsecureRemote !== true &&
    host !== "localhost" &&
    host !== "::1" &&
    host !== "127.0.0.1"
  )
    throw new Error("unauthenticated server may bind only to loopback");
  return app.listen({ host, port: options.port });
}

export function createServer(input: {
  store: AuthoritativeStore;
  coordinator: RunCoordinator;
  allowInsecureRemote?: boolean;
  shutdownGraceMs?: number;
  webRoot?: string;
}) {
  const app = Fastify({ logger: false, bodyLimit: 256_000 });

  if (input.webRoot !== undefined)
    void app.register(fastifyStatic, {
      root: input.webRoot,
      prefix: "/",
      decorateReply: true,
    });

  app.addHook("preClose", async () => {
    await input.coordinator.shutdown({ graceMs: input.shutdownGraceMs ?? 1_000 });
  });

  app.addHook("onRequest", async (request, reply) => {
    if (input.allowInsecureRemote !== true && !isLoopback(request.ip))
      return reply.code(403).send({ error: "unauthenticated server is loopback-only" });
  });

  app.get("/api/capabilities", async () => ({
    wireCancel: false,
    approval: false,
    localOnly: true,
    devDirectAgent: true,
    businessReplay: "/api/runs/:id/stream",
  }));
  app.get("/api/health", async () => ({
    status: "last-observed",
    runtimeGeneration: input.coordinator.runtime.generation,
    activeRuns: input.coordinator.runtime.activeRuns,
  }));
  app.get("/api/conversations", async () => input.store.listConversations());
  app.post("/api/conversations", async (request, reply) => {
    const body = request.body as Record<string, unknown>;
    if (typeof body?.id !== "string" || typeof body.title !== "string")
      return reply.code(400).send({ error: "invalid conversation" });
    return reply.code(201).send(
      input.store.createConversation({
        id: body.id,
        title: body.title,
        dshSessionRef: `dsh-${body.id}-g1`,
      }),
    );
  });
  app.get("/api/conversations/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const conversation = input.store.getConversation(id);
    return conversation === undefined
      ? reply.code(404).send({ error: "not found" })
      : {
          conversation,
          messages: conversationMessages(input.store, id),
          runs: input.store.listRunsByConversation(id),
        };
  });
  app.get("/api/runs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = input.store.getRun(id);
    return run === undefined
      ? reply.code(404).send({ error: "not found" })
      : {
          ...run,
          artifacts: input.store.listArtifacts(id),
          events: `/api/runs/${id}/events`,
        };
  });
  app.get("/api/runs/:id/events", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (input.store.getRun(id) === undefined) return reply.code(404).send({ error: "not found" });
    const query = request.query as { after?: string; limit?: string };
    const after = Number(query.after ?? 0);
    const limit = Number(query.limit ?? 100);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      return reply.code(400).send({ error: "invalid event cursor page" });
    return input.store.listEvents(id, after, limit);
  });
  app.get("/api/artifacts/:id", async (request, reply) => {
    const artifact = input.store.getArtifact((request.params as { id: string }).id);
    if (artifact === undefined) return reply.code(404).send({ error: "not found" });
    return reply
      .type(artifact.mediaType)
      .header("Content-Disposition", `attachment; filename="${artifact.filename}"`)
      .send(artifact.bytes);
  });
  app.post("/api/conversations/:id/acknowledge", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    try {
      return input.store.acknowledgeUnknown(
        id,
        `dsh-${id}-g${(input.store.getConversation(id)?.sessionGeneration ?? 0) + 1}`,
      );
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  app.post("/api/runtime/restart", async (_request, reply) => {
    try {
      await input.coordinator.restartRuntime();
      return { generation: input.coordinator.runtime.generation };
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/ag-ui", async (request, reply) => {
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json"))
      return reply.code(415).send({ error: "application/json is required" });
    let body;
    try {
      body = RunAgentInputSchema.parse(request.body);
    } catch (error) {
      return reply.code(400).send({
        error: "invalid RunAgentInput",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    let prompt: string;
    try {
      prompt = lastUserMessage(body);
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
    try {
      const admission = input.coordinator.admit({
        runId: body.runId,
        conversationId: body.threadId,
        prompt,
      });
      if (!admission.created)
        return reply.code(409).send({
          error: "run already exists",
          run: `/api/runs/${body.runId}`,
          replay: `/api/runs/${body.runId}/stream`,
        });
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
    const encoder = new EventEncoder({ accept: "text/event-stream" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const detached = detachSignal(request, reply.raw);
    const streamSignal = AbortSignal.any([detached.signal, input.coordinator.subscriptions.signal]);
    try {
      for await (const row of input.coordinator.subscriptions.stream(
        body.runId,
        0,
        "ag-ui",
        streamSignal,
      )) {
        await writeSseChunk(reply.raw, encoder.encode(row.payload as never), streamSignal);
      }
    } catch (error) {
      if (!streamSignal.aborted) throw error;
    } finally {
      detached.dispose();
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });

  app.get("/api/runs/:id/stream", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const query = request.query as { after?: string };
    const header = request.headers["last-event-id"];
    const after = Number(query.after ?? (Array.isArray(header) ? header[0] : header) ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      return reply.code(400).send({ error: "after must be a nonnegative integer" });
    if (input.store.getRun(id) === undefined) return reply.code(404).send({ error: "not found" });
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
    });
    const detached = detachSignal(request, reply.raw);
    const streamSignal = AbortSignal.any([detached.signal, input.coordinator.subscriptions.signal]);
    try {
      for await (const row of input.coordinator.subscriptions.stream(
        id,
        after,
        undefined,
        streamSignal,
      )) {
        await writeSseChunk(
          reply.raw,
          `id: ${row.seq}\ndata: ${JSON.stringify(row)}\n\n`,
          streamSignal,
        );
      }
    } catch (error) {
      if (!streamSignal.aborted) throw error;
    } finally {
      detached.dispose();
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
    }
  });

  return app;
}
