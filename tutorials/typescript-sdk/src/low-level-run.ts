import type { HarnessClient, HarnessNotification } from "@deepseek-ai/dsh-sdk-client";
import { textOfAssistantEvent } from "./notification-projection.ts";

export interface LowLevelRunResult {
  readonly messageId: string;
  readonly finalResponse: string;
  readonly notifications: HarnessNotification[];
  readonly observedRootEvents: string[];
}

function isMatchingReceipt(
  notification: HarnessNotification,
  sessionId: string,
  messageId: string,
): boolean {
  if (notification.method !== "session.event" || notification.params.sessionId !== sessionId)
    return false;
  const event = notification.params.event;
  if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
  const typed = event as Record<string, unknown>;
  if (typed.type !== "agent/inbox/spliced") return false;
  const data = typed.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const inserted = (data as Record<string, unknown>).inserted;
  return (
    Array.isArray(inserted) &&
    inserted.some((message) => {
      return (
        typeof message === "object" &&
        message !== null &&
        !Array.isArray(message) &&
        (message as Record<string, unknown>).id === messageId
      );
    })
  );
}

export async function runLowLevelPrompt(
  client: HarnessClient,
  sessionId: string,
  input: string,
): Promise<LowLevelRunResult> {
  const subscription = client.subscribeSessionTree(sessionId);
  const notifications: HarnessNotification[] = [];
  const observedRootEvents: string[] = [];
  let finalResponse = "";
  try {
    const messageId = await client.prompt(sessionId, [{ type: "text", text: input }]);
    let receiptSeen = false;
    for (;;) {
      const notification = await subscription.next();
      if (!receiptSeen) {
        if (!isMatchingReceipt(notification, sessionId, messageId)) continue;
        receiptSeen = true;
      }
      notifications.push(notification);
      if (notification.method === "session.event" && notification.params.sessionId === sessionId) {
        const text = textOfAssistantEvent(notification.params.event);
        if (text !== undefined) {
          observedRootEvents.push(text);
          finalResponse = text;
        }
      }
      if (
        notification.method === "session.status" &&
        notification.params.sessionId === sessionId &&
        notification.params.status === "idle"
      ) {
        return { messageId, finalResponse, notifications, observedRootEvents };
      }
    }
  } finally {
    subscription.close();
  }
}
