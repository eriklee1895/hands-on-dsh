import { it, expect } from "vitest";
import { verifyRemoteOverflow } from "../src/provider-overflow.ts";
const rejected = {
  statuses: [400],
  terminalKind: "error",
  errorCode: "CONTEXT_WINDOW_EXCEEDED",
  toolCalls: 0,
  responseText: "",
};
it("accepts an actual failed dispatch followed by the canonical overflow terminal", () => {
  expect(() => verifyRemoteOverflow(rejected)).not.toThrow();
});
it("refuses local-only overflow, unrelated provider errors and success", () => {
  for (const evidence of [
    { ...rejected, statuses: [] },
    { ...rejected, errorCode: "INVALID_REQUEST" },
    { ...rejected, statuses: [200], terminalKind: "completed", responseText: "OK" },
    { ...rejected, statuses: [400, 400] },
    { ...rejected, toolCalls: 1 },
  ])
    expect(() => verifyRemoteOverflow(evidence)).toThrow();
});

it("closes the listener even when the evidence path is unwritable", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createServer } = await import("node:http");
  const { saveAndCloseTransport } = await import("../src/provider-overflow.ts");
  const root = await mkdtemp(join(tmpdir(), "overflow-cleanup-test-"));
  const server = createServer((_req, res) => res.end("open"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port");
  try {
    await expect(
      saveAndCloseTransport(
        root,
        {},
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
    ).rejects.toThrow();
    expect(server.listening).toBe(false);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
