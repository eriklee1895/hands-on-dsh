export function lastRootCommittedText(rows, sessionId) {
  for (const row of rows.toReversed()) {
    if (
      row.channel !== "raw-dsh" ||
      row.type !== "session.event" ||
      row.payload?.method !== "session.event" ||
      row.payload?.params?.sessionId !== sessionId ||
      row.payload?.params?.event?.type !== "assistant/message"
    )
      continue;
    const content = row.payload.params.event.data?.message?.content;
    if (!Array.isArray(content)) throw new Error("last root assistant message has no content");
    return content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
  }
  return undefined;
}

export function assertExactNonceRecall(rows, sessionId, nonce) {
  const text = lastRootCommittedText(rows, sessionId)?.trim();
  if (text !== nonce)
    throw new Error("generation-two final root assistant message is not the exact nonce");
  return text;
}
