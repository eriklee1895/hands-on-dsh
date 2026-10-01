/** Loopback test proxy: observe image transport and restrict remote deletion to this run's uploads. */
import assert from "node:assert/strict";
import { writeFile, rename } from "node:fs/promises";
import { createServer } from "node:http";
import { pipeline } from "node:stream/promises";
import { createHash, timingSafeEqual } from "node:crypto";
async function* chunksOf(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) return;
      yield part.value;
    }
  } finally {
    reader.releaseLock();
  }
}
export type FilesPolicy = "forward" | "reject-all" | "reject-after-first";
export interface TransportEvidence {
  injectedRejections: { status: 501; bytes: number; sha256: string }[];
  uploads: { status: number; bytes: number; sha256: string; acknowledged: boolean }[];
  messages: {
    status: number;
    fileImages: number;
    inlineImages: number;
    inlineHashes: string[];
    fileHashes: string[];
  }[];
  blockedRequests: number;
  deletedUploads: number;
}
/** Forward to one configured endpoint; never list files or delete uploads from another run. */
export async function startTransport(
  baseURL: string,
  key: string,
  recoveryPath?: string,
  filesPolicy: FilesPolicy = "forward",
) {
  const base = new URL(baseURL);
  assert.ok(["http:", "https:"].includes(base.protocol));
  assert.ok(!base.username && !base.password && !base.search && !base.hash);
  const root = base.href.replace(/\/+$/, "").replace(/\/v1$/, "") + "/v1";
  const owned = new Map<string, string>();
  const evidence: TransportEvidence = {
    injectedRejections: [],
    uploads: [],
    messages: [],
    blockedRequests: 0,
    deletedUploads: 0,
  };
  let writes = Promise.resolve();
  // Serialize atomic snapshots so concurrent uploads cannot overwrite a newer ownership set.
  async function persistOwnership() {
    if (!recoveryPath) return;
    const snapshot = JSON.stringify(
      {
        root,
        uploads: [...owned].map(([id, sha256]) => ({ id, sha256 })),
        unacknowledgedUploads: evidence.uploads.filter((upload) => !upload.acknowledged).length,
      },
      null,
      2,
    );
    writes = writes
      .catch(() => {
        /* A later snapshot retries an earlier failed write. */
      })
      .then(async () => {
        await writeFile(recoveryPath + ".tmp", snapshot, { mode: 0o600 });
        await rename(recoveryPath + ".tmp", recoveryPath);
      });
    await writes;
  }
  const authenticated = (value: unknown) => {
    if (typeof value !== "string") return false;
    const a = Buffer.from(value),
      b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  async function remove(id: string) {
    assert.ok(owned.has(id));
    const response = await fetch(root + "/files/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: {
        "x-api-key": key,
        "anthropic-beta": "files-api-2025-04-14",
        "anthropic-version": "2023-06-01",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status !== 404) {
      assert.ok(response.ok, "test upload cleanup failed");
      const body: unknown = await response.json();
      assert.ok(
        typeof body === "object" &&
          body !== null &&
          "id" in body &&
          body.id === id &&
          "type" in body &&
          body.type === "file_deleted",
      );
    } else await response.arrayBuffer();
    owned.delete(id);
    evidence.deletedUploads++;
    await persistOwnership();
  }
  const server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      const fileMatch = path.match(/^\/v1\/files\/([^/]+)$/);
      const id = fileMatch ? decodeURIComponent(fileMatch[1]!) : undefined;
      const isUpload = path === "/v1/files" && req.method === "POST";
      const isMessage = path === "/v1/messages" && req.method === "POST";
      const isOwnedFile =
        id !== undefined && owned.has(id) && (req.method === "GET" || req.method === "DELETE");
      if (!authenticated(req.headers["x-api-key"]) || (!isUpload && !isMessage && !isOwnedFile)) {
        evidence.blockedRequests++;
        req.resume();
        res.writeHead(403, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { type: "permission_error", message: "outside experiment scope" },
          }),
        );
        return;
      }
      if (isOwnedFile && req.method === "DELETE") {
        await remove(id!);
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id, type: "file_deleted" }));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        total += bytes.length;
        if (total > 8 * 1024 * 1024) throw new Error("experiment body limit");
        chunks.push(bytes);
      }
      const payload = Buffer.concat(chunks);
      const headers: Record<string, string> = { "x-api-key": key };
      for (const name of ["content-type", "anthropic-beta", "anthropic-version"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      let upload: TransportEvidence["uploads"][number] | undefined;
      let message:
        | { fileImages: number; inlineImages: number; inlineHashes: string[]; fileHashes: string[] }
        | undefined;
      if (isUpload) {
        const form = await new Response(payload, {
          headers: { "content-type": headers["content-type"] ?? "" },
        }).formData();
        const file = form.get("file");
        assert.ok(file instanceof Blob);
        const bytes = Buffer.from(await file.arrayBuffer());
        const image = {
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        if (
          filesPolicy === "reject-all" ||
          (filesPolicy === "reject-after-first" && evidence.uploads.length >= 1)
        ) {
          evidence.injectedRejections.push({ status: 501, ...image });
          res.writeHead(501, { "content-type": "application/json" }).end(
            JSON.stringify({
              type: "error",
              error: { type: "api_error", message: "Files disabled by local experiment" },
            }),
          );
          return;
        }
        upload = {
          status: 0,
          ...image,
          acknowledged: false,
        };
        evidence.uploads.push(upload);
        await persistOwnership();
      }
      if (isMessage) {
        const body = JSON.parse(payload.toString()) as { messages?: unknown };
        message = { fileImages: 0, inlineImages: 0, inlineHashes: [], fileHashes: [] };
        const inspect = (value: unknown) => {
          if (Array.isArray(value)) {
            for (const item of value) inspect(item);
            return;
          }
          if (value === null || typeof value !== "object") return;
          const item = value as Record<string, unknown>;
          if (item.type === "image" && item.source !== null && typeof item.source === "object") {
            const source = item.source as Record<string, unknown>;
            if (source.type === "file") {
              assert.equal(typeof source.file_id, "string");
              const hash = owned.get(String(source.file_id));
              assert.ok(hash, "image must reference this run upload");
              message!.fileImages++;
              message!.fileHashes.push(hash);
            }
            if (source.type === "base64" && typeof source.data === "string") {
              message!.inlineImages++;
              message!.inlineHashes.push(
                createHash("sha256").update(Buffer.from(source.data, "base64")).digest("hex"),
              );
            }
          }
          for (const item of Object.values(value)) if (typeof item === "object") inspect(item);
        };
        inspect(body.messages);
      }
      const controller = new AbortController();
      const abort = () => {
        if (!res.writableEnded) controller.abort();
      };
      res.once("close", abort);
      try {
        const remote = await fetch(root + path.slice("/v1".length), {
          method: req.method,
          headers,
          ...(payload.length ? { body: payload } : {}),
          redirect: "manual",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
        });
        if (upload) {
          upload.status = remote.status;
          const bytes = Buffer.from(await remote.arrayBuffer());
          if (remote.ok) {
            let value: unknown;
            try {
              value = JSON.parse(bytes.toString());
            } catch (error) {
              void error; /* Preserve unknown ownership; the adapter receives the original invalid response. */
            }
            if (
              typeof value === "object" &&
              value !== null &&
              "id" in value &&
              typeof value.id === "string" &&
              value.id.length > 0
            ) {
              owned.set(value.id, upload.sha256);
              upload.acknowledged = true;
            }
          }
          await persistOwnership();
          res
            .writeHead(remote.status, {
              "content-type": remote.headers.get("content-type") ?? "application/json",
            })
            .end(bytes);
          return;
        }
        if (message) evidence.messages.push({ status: remote.status, ...message });
        res.writeHead(remote.status, {
          "content-type": remote.headers.get("content-type") ?? "application/octet-stream",
        });
        if (remote.body) await pipeline(chunksOf(remote.body), res);
        else res.end();
      } finally {
        res.off("close", abort);
      }
    })().catch(() => {
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { type: "api_error", message: "experiment forwarding failed" },
          }),
        );
      else res.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}`,
    evidence,
    async cleanup() {
      await persistOwnership();
      for (const id of owned.keys()) await remove(id);
      assert.ok(
        !evidence.uploads.some((upload) => !upload.acknowledged),
        "upload ownership is unconfirmed",
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
