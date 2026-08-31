import { MessageSchema } from "@ag-ui/core";
import { z } from "zod";

const RecoveryStateSchema = z.enum(["active", "blocked"]);
const RunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "execution_unknown"]);

export const ConversationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    dshSessionRef: z.string().min(1),
    sessionGeneration: z.number().int().positive(),
    recoveryState: RecoveryStateSchema,
  })
  .strict();

export const RunSchema = z
  .object({
    id: z.string().min(1),
    conversationId: z.string().min(1),
    admissionSeq: z.number().int().positive(),
    request: z.unknown(),
    fingerprint: z.string().min(1),
    status: RunStatusSchema,
    dshSessionRef: z.string().min(1),
  })
  .strict();

export const RunEventSchema = z
  .object({
    runId: z.string().min(1),
    seq: z.number().int().positive(),
    channel: z.enum(["business", "raw-dsh", "ag-ui"]),
    type: z.string().min(1),
    payload: z.unknown(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export const ArtifactSchema = z
  .object({
    id: z.string().min(1),
    filename: z.string().min(1),
    mediaType: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f\d]{64}$/u),
  })
  .strict();

export const ConversationSnapshotSchema = z
  .object({
    conversation: ConversationSchema,
    messages: z.array(MessageSchema),
    runs: z.array(RunSchema),
  })
  .strict();

export const RunDetailSchema = RunSchema.extend({
  artifacts: z.array(ArtifactSchema),
  events: z.string().min(1),
}).strict();

export const CapabilitiesSchema = z
  .object({
    wireCancel: z.literal(false),
    approval: z.literal(false),
    localOnly: z.literal(true),
    devDirectAgent: z.literal(true),
    businessReplay: z.string().min(1),
  })
  .strict();

export const HealthSchema = z
  .object({
    status: z.literal("last-observed"),
    runtimeGeneration: z.number().int().positive(),
    activeRuns: z.number().int().nonnegative(),
  })
  .strict();

export type ConversationSummary = z.infer<typeof ConversationSchema>;
export type RunSummary = z.infer<typeof RunSchema>;
export type RunEvent = z.infer<typeof RunEventSchema>;
export type ConversationSnapshot = z.infer<typeof ConversationSnapshotSchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type Health = z.infer<typeof HealthSchema>;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function validated<T>(schema: z.ZodType<T>, value: unknown, path: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `invalid response from ${path}: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  return parsed.data;
}

export class ApiClient {
  constructor(private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis)) {}

  private async getJson<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const response = await this.fetcher(path, { signal });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error(`invalid response from ${path}: JSON required`, { cause: error });
    }
    return validated(schema, body, path);
  }

  private async postJson<T>(path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const response = await this.fetcher(path, {
      method: "POST",
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    let value: unknown;
    try {
      value = await response.json();
    } catch (error) {
      throw new Error(`invalid response from ${path}: JSON required`, { cause: error });
    }
    return validated(schema, value, path);
  }

  listConversations(signal?: AbortSignal): Promise<ConversationSummary[]> {
    return this.getJson("/api/conversations", z.array(ConversationSchema), signal);
  }

  getConversation(conversationId: string, signal?: AbortSignal): Promise<ConversationSnapshot> {
    const path = `/api/conversations/${encodeURIComponent(conversationId)}`;
    return this.getJson(path, ConversationSnapshotSchema, signal);
  }

  getRun(runId: string, signal?: AbortSignal): Promise<RunDetail> {
    const path = `/api/runs/${encodeURIComponent(runId)}`;
    return this.getJson(path, RunDetailSchema, signal);
  }

  listRunEvents(runId: string, after: number, signal?: AbortSignal): Promise<RunEvent[]> {
    const path = `/api/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=500`;
    return this.getJson(path, z.array(RunEventSchema), signal);
  }

  getCapabilities(signal?: AbortSignal): Promise<Capabilities> {
    return this.getJson("/api/capabilities", CapabilitiesSchema, signal);
  }

  getHealth(signal?: AbortSignal): Promise<Health> {
    return this.getJson("/api/health", HealthSchema, signal);
  }

  createConversation(id: string, title: string): Promise<ConversationSummary> {
    return this.postJson("/api/conversations", ConversationSchema, { id, title });
  }

  restartRuntime(): Promise<{ generation: number }> {
    return this.postJson(
      "/api/runtime/restart",
      z.object({ generation: z.number().int().positive() }).strict(),
    );
  }

  acknowledgeUnknown(conversationId: string): Promise<ConversationSummary> {
    return this.postJson(
      `/api/conversations/${encodeURIComponent(conversationId)}/acknowledge`,
      ConversationSchema,
    );
  }

  artifactUrl(artifactId: string): string {
    return `/api/artifacts/${encodeURIComponent(artifactId)}`;
  }

  async streamRunEvents(
    runId: string,
    after: number,
    signal: AbortSignal,
    onEvent: (event: RunEvent) => void,
  ): Promise<void> {
    const path = `/api/runs/${encodeURIComponent(runId)}/stream?after=${after}`;
    const response = await this.fetcher(path, {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream"))
      throw new Error(`invalid response from ${path}: text/event-stream required`);
    if (response.body === null) throw new Error(`invalid response from ${path}: body required`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let separator = buffer.search(/\r?\n\r?\n/u);
      while (separator !== -1) {
        const frame = buffer.slice(0, separator);
        const separatorLength = buffer.startsWith("\r\n\r\n", separator) ? 4 : 2;
        buffer = buffer.slice(separator + separatorLength);
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data !== "") {
          let value: unknown;
          try {
            value = JSON.parse(data);
          } catch (error) {
            throw new Error(`invalid response from ${path}: SSE data must be JSON`, {
              cause: error,
            });
          }
          onEvent(validated(RunEventSchema, value, path));
        }
        separator = buffer.search(/\r?\n\r?\n/u);
      }
      if (chunk.done) break;
    }
    if (buffer.trim() !== "")
      throw new Error(`invalid response from ${path}: incomplete SSE frame`);
  }
}
