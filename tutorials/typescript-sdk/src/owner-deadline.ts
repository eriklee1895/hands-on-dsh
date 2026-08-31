export interface AsyncOwner {
  close(): Promise<void>;
}

export async function withOwnerDeadline<T>(
  label: string,
  timeoutMs: number,
  owner: AsyncOwner,
  operation: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const operationOutcome = Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ kind: "value" as const, value }),
      (error: unknown) => ({ kind: "operation-error" as const, error }),
    );
  const timeoutOutcome = new Promise<{ kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => {
      resolve({ kind: "deadline" });
    }, timeoutMs);
  });
  try {
    const outcome = await Promise.race([operationOutcome, timeoutOutcome]);
    if (outcome.kind === "value") return outcome.value;
    if (outcome.kind === "operation-error") throw outcome.error;

    const deadlineError = new Error(
      `${label} exceeded the ${timeoutMs}ms receipt-to-idle deadline; runtime closed`,
    );
    try {
      await owner.close();
    } catch (closeError) {
      throw new AggregateError(
        [deadlineError, closeError],
        `${label} exceeded the ${timeoutMs}ms deadline and runtime close failed`,
      );
    }
    throw deadlineError;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
