function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A settled SDK run may contain a failed or truncated turn. */
export function requireCompletedTurn(events: readonly unknown[]): void {
  const ending = events
    .map(record)
    .filter((event) => event?.type === "turn/end")
    .at(-1);
  const reason = record(record(ending?.data)?.reason);
  if (reason?.kind !== "completed") {
    throw new Error(`turn ended without completion: ${String(reason?.kind ?? "missing")}`);
  }
}

/** Example 02 demonstrates memory only when the normalized second answer exactly matches its nonce. */
export function requireRememberedNonce(answer: string, nonce: string): void {
  if (answer.trim().normalize("NFKC") !== nonce.trim().normalize("NFKC")) {
    throw new Error(`second turn did not recall ${nonce}`);
  }
}
