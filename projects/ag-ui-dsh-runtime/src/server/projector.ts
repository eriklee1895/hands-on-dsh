import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core";

interface StepState {
  textOpen: boolean;
  streamedText: string;
  assistantCommitted: boolean;
  committedCalls: Map<string, { name: string; arguments: string }>;
  calls: Map<string, { settled: boolean }>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`malformed ${label}`);
  return value as number;
}

export class AguiProjector {
  private readonly steps = new Map<string, StepState>();

  constructor(private readonly rootSessionId: string) {}

  private ids(turn: number, step: number) {
    const stem = `${this.rootSessionId}-${turn}-${step}`;
    return { key: stem, stepName: `dsh-step-${stem}`, messageId: `dsh-message-${stem}` };
  }

  private validated(events: unknown[]): AGUIEvent[] {
    return events.map((event) => EventSchemas.parse(event));
  }

  accept(notification: { method: string; params: Record<string, unknown> }): AGUIEvent[] {
    if (notification.method === "subagent.started" || notification.method === "subagent.finished") {
      if (notification.params.parentSessionId !== this.rootSessionId) return [];
      return this.validated([
        {
          type: EventType.CUSTOM,
          name: `dsh.${notification.method}`,
          value: notification.params,
        },
      ]);
    }
    if (
      notification.method !== "session.event" ||
      notification.params.sessionId !== this.rootSessionId
    )
      return [];
    const event = record(notification.params.event);
    const data = record(event?.data);
    if (event === undefined || data === undefined) throw new Error("malformed DSH session event");
    const type = event.type;
    if (type === "step/start") {
      const turn = integer(data.turn, "turn");
      const step = integer(data.step, "step");
      const ids = this.ids(turn, step);
      if (this.steps.has(ids.key)) throw new Error("duplicate step start");
      this.steps.set(ids.key, {
        textOpen: false,
        streamedText: "",
        assistantCommitted: false,
        committedCalls: new Map(),
        calls: new Map(),
      });
      return this.validated([{ type: EventType.STEP_STARTED, stepName: ids.stepName }]);
    }
    if (
      !["assistant/chunk", "assistant/message", "tool/call", "tool/result", "step/end"].includes(
        String(type),
      )
    )
      return [];
    const turn = integer(data.turn, "turn");
    const step = integer(data.step, "step");
    const ids = this.ids(turn, step);
    const state = this.steps.get(ids.key);
    if (state === undefined) throw new Error(`${String(type)} without step start`);
    if (type === "assistant/chunk") {
      const chunk = record(data.chunk);
      if (chunk?.type !== "text-delta" || typeof chunk.text !== "string") return [];
      const output: unknown[] = [];
      if (!state.textOpen) {
        state.textOpen = true;
        output.push({
          type: EventType.TEXT_MESSAGE_START,
          messageId: ids.messageId,
          role: "assistant",
        });
      }
      state.streamedText += chunk.text;
      output.push({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: ids.messageId,
        delta: chunk.text,
      });
      return this.validated(output);
    }
    if (type === "assistant/message") {
      if (state.assistantCommitted) throw new Error("duplicate committed assistant message");
      const message = record(data.message);
      const content = message?.content;
      if (!Array.isArray(content)) throw new Error("malformed assistant message content");
      for (const value of content) {
        const block = record(value);
        if (block?.type !== "tool-call") continue;
        if (
          typeof block.id !== "string" ||
          block.id === "" ||
          typeof block.name !== "string" ||
          typeof block.arguments !== "string"
        )
          throw new Error("committed assistant tool call id is malformed");
        if (state.committedCalls.has(block.id))
          throw new Error("duplicate committed assistant tool call id");
        state.committedCalls.set(block.id, { name: block.name, arguments: block.arguments });
      }
      const text = content
        .map((block) => record(block))
        .filter(
          (block): block is Record<string, unknown> =>
            block?.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text as string)
        .join("");
      if (state.textOpen) {
        if (text !== state.streamedText)
          throw new Error("committed text differs from streamed deltas");
        state.textOpen = false;
        state.assistantCommitted = true;
        return this.validated([{ type: EventType.TEXT_MESSAGE_END, messageId: ids.messageId }]);
      }
      state.assistantCommitted = true;
      if (text === "") return [];
      return this.validated([
        { type: EventType.TEXT_MESSAGE_START, messageId: ids.messageId, role: "assistant" },
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: ids.messageId, delta: text },
        { type: EventType.TEXT_MESSAGE_END, messageId: ids.messageId },
      ]);
    }
    if (type === "tool/call") {
      if (!state.assistantCommitted)
        throw new Error("tool call requires a committed assistant message");
      if (typeof data.callId !== "string" || data.callId === "")
        throw new Error("malformed tool call id");
      const callId = data.callId;
      const committed = state.committedCalls.get(callId);
      if (committed === undefined)
        throw new Error("tool call is absent from the committed assistant message");
      if (state.calls.has(callId)) throw new Error("duplicate tool call");
      if (typeof data.name !== "string" || typeof data.arguments !== "string")
        throw new Error("malformed tool call");
      if (data.name !== committed.name || data.arguments !== committed.arguments)
        throw new Error("durable tool call differs from committed assistant tool call");
      state.calls.set(callId, { settled: false });
      return this.validated([
        {
          type: EventType.TOOL_CALL_START,
          toolCallId: callId,
          toolCallName: data.name,
          parentMessageId: ids.messageId,
        },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: callId, delta: data.arguments },
        { type: EventType.TOOL_CALL_END, toolCallId: callId },
      ]);
    }
    if (type === "tool/result") {
      const message = record(data.message);
      const blocks = message?.content;
      const block = Array.isArray(blocks) ? record(blocks[0]) : undefined;
      if (block?.type !== "tool-result") throw new Error("malformed tool result");
      if (typeof block.toolCallId !== "string" || block.toolCallId === "")
        throw new Error("malformed tool result call id");
      const callId = block.toolCallId;
      const call = state.calls.get(callId);
      if (call === undefined) throw new Error("orphan tool result");
      if (call.settled) throw new Error("duplicate tool result");
      if (typeof block.isError !== "boolean")
        throw new Error("tool result isError must be boolean");
      call.settled = true;
      const envelope = {
        isError: block.isError,
        content: block.content ?? [],
        ...(data.error === undefined ? {} : { error: data.error }),
      };
      return this.validated([
        {
          type: EventType.TOOL_CALL_RESULT,
          messageId: `dsh-tool-result-${this.rootSessionId}-${callId}`,
          toolCallId: callId,
          content: JSON.stringify(envelope),
          role: "tool",
        },
      ]);
    }
    if (state.textOpen) throw new Error("step ended with open text message");
    if (!state.assistantCommitted)
      throw new Error("step ended without a committed assistant message");
    if (state.calls.size !== state.committedCalls.size)
      throw new Error("step ended without every committed tool call");
    if ([...state.calls.values()].some((call) => !call.settled))
      throw new Error("step ended with pending tool results");
    this.steps.delete(ids.key);
    return this.validated([{ type: EventType.STEP_FINISHED, stepName: ids.stepName }]);
  }

  assertClosed(): void {
    if (this.steps.size !== 0) throw new Error("projector has open steps");
  }
}
