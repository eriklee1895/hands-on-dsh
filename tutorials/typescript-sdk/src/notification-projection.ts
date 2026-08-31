import type { HarnessNotification } from "@deepseek-ai/dsh-sdk-client";

export interface NotificationSnapshot {
  readonly rootText: string;
  readonly toolCalls: number;
  readonly toolResults: number;
  readonly subagentsStarted: number;
  readonly subagentsFinished: number;
  readonly running: number;
  readonly idle: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assistantText(event: unknown): string | undefined {
  const envelope = record(event);
  if (envelope?.type !== "assistant/message") return undefined;
  const data = record(envelope.data);
  const message = record(data?.message);
  const content = message?.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((block) => record(block))
    .filter(
      (block): block is Record<string, unknown> =>
        block?.type === "text" && typeof block.text === "string",
    )
    .map((block) => block.text as string)
    .join("");
}

function assistantChunkText(event: unknown): string | undefined {
  const envelope = record(event);
  if (envelope?.type !== "assistant/chunk") return undefined;
  const data = record(envelope.data);
  const chunk = record(data?.chunk);
  return chunk?.type === "text-delta" && typeof chunk.text === "string" ? chunk.text : undefined;
}

export class NotificationProjection {
  private rootText = "";
  private toolCalls = 0;
  private toolResults = 0;
  private subagentsStarted = 0;
  private subagentsFinished = 0;
  private running = 0;
  private idle = 0;

  constructor(private readonly rootSessionId: string) {}

  accept(notification: HarnessNotification): void {
    const params = notification.params;
    if (notification.method === "subagent.started") this.subagentsStarted += 1;
    if (notification.method === "subagent.finished") this.subagentsFinished += 1;
    if (notification.method === "session.status" && params.sessionId === this.rootSessionId) {
      if (params.status === "running") this.running += 1;
      if (params.status === "idle") this.idle += 1;
    }
    if (notification.method !== "session.event" || params.sessionId !== this.rootSessionId) return;
    const event = record(params.event);
    if (event?.type === "tool/call") this.toolCalls += 1;
    if (event?.type === "tool/result") this.toolResults += 1;
    const text = assistantChunkText(event);
    if (text !== undefined) this.rootText += text;
  }

  snapshot(): NotificationSnapshot {
    return {
      rootText: this.rootText,
      toolCalls: this.toolCalls,
      toolResults: this.toolResults,
      subagentsStarted: this.subagentsStarted,
      subagentsFinished: this.subagentsFinished,
      running: this.running,
      idle: this.idle,
    };
  }
}

export function textOfAssistantEvent(event: unknown): string | undefined {
  return assistantText(event);
}
