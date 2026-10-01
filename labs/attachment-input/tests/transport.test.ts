import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { it, expect } from "vitest";
import { startTransport } from "../src/transport.ts";
it("forwards only permitted paths, records images, and deletes only its own uploads", async () => {
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    requests.push(req.method + " " + req.url);
    for await (const _chunk of req) {
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/anthropic/v1/files" && req.method === "POST")
      res.end(JSON.stringify({ id: "file-owned", type: "file" }));
    else if (req.method === "DELETE")
      res.end(JSON.stringify({ id: "file-owned", type: "file_deleted" }));
    else res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("port");
  const proxy = await startTransport(`http://127.0.0.1:${addr.port}/anthropic`, "test-key");
  try {
    expect((await fetch(proxy.url + "/v1/messages", { method: "POST", body: "{}" })).status).toBe(
      403,
    );
    const form = new FormData();
    form.set("file", new Blob(["fixture-image"], { type: "image/png" }), "dsh-fixture.png");
    const uploaded = await fetch(proxy.url + "/v1/files", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: form,
    });
    expect(uploaded.status).toBe(200);
    const msg = await fetch(proxy.url + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "test-key", "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "file", file_id: "file-owned" } },
              {
                type: "image",
                source: { type: "base64", data: Buffer.from("image").toString("base64") },
              },
            ],
          },
        ],
      }),
    });
    expect(msg.status).toBe(200);
    expect(
      (await fetch(proxy.url + "/v1/files", { headers: { "x-api-key": "test-key" } })).status,
    ).toBe(403);
    expect(
      (
        await fetch(proxy.url + "/v1/files/other", {
          method: "DELETE",
          headers: { "x-api-key": "test-key" },
        })
      ).status,
    ).toBe(403);
    await proxy.cleanup();
    await proxy.cleanup();
    expect(proxy.evidence.deletedUploads).toBe(1);
    expect(proxy.evidence.uploads).toMatchObject([{ acknowledged: true, bytes: 13 }]);
    expect(proxy.evidence.messages).toMatchObject([
      {
        fileImages: 1,
        inlineImages: 1,
        fileHashes: [createHash("sha256").update("fixture-image").digest("hex")],
        inlineHashes: [createHash("sha256").update("image").digest("hex")],
      },
    ]);
    expect(requests).toEqual([
      "POST /anthropic/v1/files",
      "POST /anthropic/v1/messages",
      "DELETE /anthropic/v1/files/file-owned",
    ]);
    expect(JSON.stringify(proxy.evidence)).not.toContain("test-key");
    expect(JSON.stringify(proxy.evidence)).not.toContain("file-owned");
  } finally {
    await proxy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("does not report cleanup confirmed after an upload succeeds without a usable ID", async () => {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    res.writeHead(200, { "content-type": "application/json" }).end("not-json");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("port");
  const proxy = await startTransport(`http://127.0.0.1:${addr.port}`, "test-key");
  try {
    const form = new FormData();
    form.set("file", new Blob(["fixture"]), "dsh.png");
    await fetch(proxy.url + "/v1/files", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: form,
    });
    await expect(proxy.cleanup()).rejects.toThrow();
    expect(proxy.evidence.uploads).toMatchObject([{ status: 200, acknowledged: false }]);
  } finally {
    await proxy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it.each([302, 408, 500, 502, 504])(
  "keeps a forwarded upload with HTTP %i and no ID unresolved",
  async (status) => {
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      res.writeHead(status, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("port");
    const proxy = await startTransport(`http://127.0.0.1:${addr.port}`, "test-key");
    try {
      const form = new FormData();
      form.set("file", new Blob(["fixture"]), "dsh.png");
      await fetch(proxy.url + "/v1/files", {
        method: "POST",
        headers: { "x-api-key": "test-key" },
        body: form,
      });
      await expect(proxy.cleanup()).rejects.toThrow();
    } finally {
      await proxy.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it("retains private ownership when deletion fails and removes IDs after confirmed deletion", async () => {
  const { mkdtemp, readFile, stat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "attachment-cleanup-test-"));
  const manifest = join(directory, "cleanup.json");
  let deleteFails = true;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
    }
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") res.end(JSON.stringify({ id: "file-owned" }));
    else if (deleteFails) res.writeHead(502).end("{}");
    else res.end(JSON.stringify({ id: "file-owned", type: "file_deleted" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("port");
  const proxy = await startTransport(`http://127.0.0.1:${addr.port}`, "test-key", manifest);
  try {
    const form = new FormData();
    form.set("file", new Blob(["fixture"]), "dsh.png");
    await fetch(proxy.url + "/v1/files", {
      method: "POST",
      headers: { "x-api-key": "test-key" },
      body: form,
    });
    await expect(proxy.cleanup()).rejects.toThrow();
    const text = await readFile(manifest, "utf8");
    expect(text).not.toContain("test-key");
    expect(JSON.parse(text).uploads).toMatchObject([{ id: "file-owned" }]);
    expect((await stat(manifest)).mode & 0o777).toBe(0o600);
    deleteFails = false;
    await proxy.cleanup();
    expect(JSON.parse(await readFile(manifest, "utf8")).uploads).toEqual([]);
  } finally {
    await proxy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
