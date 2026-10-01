/* Run with agent-browser eval --stdin on the authenticated official Web page. */
(async () => {
  const mode = sessionStorage.getItem("dsh.webRecovery.mode");
  if (!["admission", "serial", "concurrent"].includes(mode)) {
    throw new Error("Set dsh.webRecovery.mode to admission, serial, or concurrent first");
  }
  const selected = JSON.parse(localStorage.getItem("dsh.sessions.current"));
  const sessionId = selected?.sessionId;
  if (typeof sessionId !== "string" || !sessionId.startsWith("session-")) {
    throw new Error("Select a new Session in the disposable workspace");
  }
  const runKey = `dsh.webRecovery.executed.${mode}.${sessionId}`;
  if (sessionStorage.getItem(runKey) !== null) {
    throw new Error("This probe was already submitted in this Session; inspect durable history");
  }
  sessionStorage.setItem(runKey, "attempted");

  async function send(requestId, text, signal) {
    const rpcId = crypto.randomUUID();
    const request = {
      requestId,
      sessionId,
      mode: "queue",
      content: [{ type: "text", text }],
    };
    try {
      const response = await fetch("/api/session/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "client-request",
          rpcId,
          method: "session/prompt",
          payload: { args: { request } },
        }),
        ...(signal === undefined ? {} : { signal }),
      });
      const body = await response.json();
      return {
        http: response.status,
        accepted: body?.result?.value?.accepted === true,
        errorCode: body?.result?.error?.code ?? null,
      };
    } catch (error) {
      return { transport: error instanceof Error ? error.name : "UnknownError" };
    }
  }

  if (mode === "serial") {
    const requestId = crypto.randomUUID();
    const text =
      "Call bash exactly once with command: printf '%s' 'DUP' >> duplicate-count.txt . Do not include the final period, use no other tools, do not retry, then reply exactly DUPLICATE_OK.";
    const first = await send(requestId, text);
    const second = await send(requestId, text);
    return { mode, sessionId, first, second };
  }
  if (mode === "concurrent") {
    const requestId = crypto.randomUUID();
    const text = "Reply exactly CONCURRENT_DUP. Do not use tools.";
    const outcomes = await Promise.all([send(requestId, text), send(requestId, text)]);
    return { mode, sessionId, requestId, outcomes };
  }
  const beforeAbort = crypto.randomUUID();
  const afterAbort = crypto.randomUUID();
  async function abortAfter(requestId, text, delayMs) {
    const controller = new AbortController();
    const pending = send(requestId, text, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    controller.abort();
    return await pending;
  }
  const before = await abortAfter(
    beforeAbort,
    "Reply exactly ADMISSION_PROBE. Do not use tools.",
    0,
  );
  const after = await abortAfter(
    afterAbort,
    "Reply exactly ADMISSION_PROBE_2. Do not use tools.",
    5,
  );
  return { mode, sessionId, beforeAbort, afterAbort, before, after };
})();
