/** Real SDK image admission and vision requests over a narrowly observed transport. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import Store from "@deepseek-ai/dsh-attachment-local";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { DeepSeekHarness, type RunResult } from "@deepseek-ai/dsh-sdk-client";
import { resolveAdapterOptions, resolveRequestImageTarget } from "@deepseek-ai/dsh-llm-deepseek";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import sharp from "sharp";
import { grid, shuffledColors } from "../src/fixture.ts";
import { verifyAnswer, verifyTransport } from "../src/verify.ts";
import { startTransport } from "../src/transport.ts";
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
async function bounded(owner: DeepSeekHarness, work: () => Promise<RunResult>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("image run deadline")), 120000);
      }),
    ]);
  } catch (error) {
    await owner.close();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const { values } = parseArgs({ options: { files: { type: "string", default: "forward" } } });
  const policy = values.files;
  assert.ok(
    policy === "forward" || policy === "reject-all" || policy === "reject-after-first",
    "files policy must be forward, reject-all or reject-after-first",
  );
  const key = process.env.DEEPSEEK_API_KEY;
  assert.ok(key, "Set DEEPSEEK_API_KEY");
  const root = await mkdtemp(join(tmpdir(), "dsh-attachment-input-"));
  const workspace = join(root, "workspace"),
    home = join(root, "home"),
    dshHome = join(root, "dsh-home");
  let owner: DeepSeekHarness | undefined;
  let closed = true;
  let proxy: Awaited<ReturnType<typeof startTransport>> | undefined;
  let cleanupAttempted = false;
  let cleaned = false;
  let verified = false;
  try {
    await mkdir(workspace);
    await mkdir(home);
    const firstOrder = shuffledColors();
    let secondOrder = shuffledColors();
    while (JSON.stringify(secondOrder) === JSON.stringify(firstOrder))
      secondOrder = shuffledColors();
    const expected = [firstOrder, secondOrder];
    const sources = await Promise.all(expected.map((order) => grid(order)));
    for (const source of sources) {
      const meta = await sharp(source).metadata();
      assert.equal(meta.exif, undefined);
      assert.equal(meta.width, 512);
      assert.equal(meta.height, 512);
    }
    proxy = await startTransport(
      process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/anthropic",
      key,
      join(root, "cleanup.json"),
      policy,
    );
    const patch = join(root, "attachment.json");
    await writeFile(
      patch,
      JSON.stringify([
        {
          id: "llm-deepseek",
          config: {
            apiKeyEnv: "DEEPSEEK_API_KEY",
            reasoningEffort: "off",
            maxTokens: 512,
            streamIdleTimeoutMs: 30000,
            filesApiTimeoutMs: 30000,
            fileExpiresAfterSeconds: 3600,
            fileRefreshMarginSeconds: 60,
            retryPolicy: { mode: "normal", maxRetries: 0 },
          },
        },
        {
          insert: [
            {
              id: "lesson-attachments",
              name: fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-attachment-local")),
              config: {
                dshHome,
                normalizedImageMaxPixels: 256 * 256,
                normalizedImageMaxDimension: 256,
              },
            },
          ],
        },
      ]),
    );
    owner = new DeepSeekHarness({
      profile: "sdk-minimal",
      patches: [patch],
      cwd: workspace,
      processCwd: workspace,
      dshHome,
      provider: "deepseek-official",
      model: "deepseek-flash",
      reasoningEffort: ReasoningEffortId("off"),
      maxTokens: 512,
      initializeTimeoutMs: 60000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: process.env.TMPDIR,
        DEEPSEEK_API_KEY: key,
        DEEPSEEK_BASE_URL: proxy.url,
      },
    });
    closed = false;
    await owner.start();
    const sessionId = "images-" + randomUUID();
    const subscription = owner.client.subscribe(
      (n) => n.method === "session.event" && n.params.sessionId === sessionId,
    );
    const events: SessionEvent[] = [];
    const drain = () => {
      let note;
      while ((note = subscription.tryNext()) !== undefined)
        if (note.method === "session.event") events.push(note.params.event as SessionEvent);
    };
    let responses: RunResult[];
    try {
      const session = owner.session(sessionId);
      const prompt =
        "Inspect the two attached images. Each is a 2 by 2 grid with four solid colours. For each image list the colours in this order: top-left, top-right, bottom-left, bottom-right. Use only red, green, blue, yellow. Return ONLY a JSON array containing two arrays of four colour names, in image order. Do not call tools, read files, or infer colours from filenames.";
      const first = await bounded(owner, () =>
        session.run([
          { type: "text", text: prompt },
          ...sources.map((data) => ({
            type: "image" as const,
            data: data.toString("base64"),
            mimeType: "image/png" as const,
          })),
        ]),
      );
      verifyAnswer(first.finalResponse, expected);
      drain();
      const prefix = structuredClone(events);
      console.log(JSON.stringify({ firstVisionMatched: true, sourceImages: 2 }));
      const second = await bounded(owner, () =>
        session.run(
          "Inspect the same two images from the previous message again. Return ONLY the same format: two arrays of four colours ordered top-left, top-right, bottom-left, bottom-right. Use only red, green, blue, yellow. Do not call tools or read files.",
        ),
      );
      verifyAnswer(second.finalResponse, expected);
      drain();
      assert.deepEqual(events.slice(0, prefix.length), prefix);
      responses = [first, second];
      await owner.close();
      closed = true;
      drain();
    } finally {
      subscription.close();
    }
    for (const response of responses) {
      assert.equal(
        response.events.filter((e) => e.type === "turn/end").at(-1)?.data.reason.kind,
        "completed",
      );
      assert.equal(response.events.filter((e) => e.type === "tool/call").length, 0);
    }
    const context = new Context();
    const model = resolveAdapterOptions({}).models.find((model) => model.id === "deepseek-flash");
    assert.ok(model);
    let storedEvidence: {
      requestSha256: string;
      sourceBytes: number;
      sourceSha256: string;
      normalizedBytes: number;
      normalizedSha256: string;
      normalizedDimensions: number[];
      requestVariantId: string;
      requestVariantBytes: number;
      requestDimensions: number[];
    }[] = [];
    try {
      await context.plugin(Store, { dshHome });
      await context.plugin(Persistence, { root: join(dshHome, "sessions"), compression: "none" });
      const reader = await context.sessionPersistence.open(SessionId(sessionId), "read");
      let persisted: readonly SessionEvent[];
      try {
        assert.equal(reader.header.version, 4);
        persisted = (await reader.read()).events;
      } finally {
        await reader.close();
      }
      assert.deepEqual(persisted, events);
      const refs = persisted.flatMap((e) =>
        e.type === "user/message"
          ? e.data.content.filter((b) => b.type === "image").map((b) => b.attachment)
          : [],
      );
      assert.equal(refs.length, 2);
      assert.ok(!JSON.stringify(refs).includes("base64"));
      for (const source of sources)
        assert.ok(!JSON.stringify(persisted).includes(source.toString("base64")));
      storedEvidence = await Promise.all(
        refs.map(async (ref, index) => {
          const stored = await context.attachments.readImage(ref);
          const metadata = await sharp(stored.data).metadata();
          assert.equal(ref.width, 256);
          assert.equal(ref.height, 256);
          assert.equal(ref.mediaType, "image/jpeg");
          assert.deepEqual(ref.originalDimensions, { width: 512, height: 512 });
          assert.equal(metadata.exif, undefined);
          assert.equal(ref.attachmentId, "sha256:" + sha(stored.data));
          assert.notEqual(sha(stored.data), sha(sources[index]!));
          const path = context.attachments.imageHostPath(ref);
          assert.ok(path);
          assert.equal(sha(await readFile(path)), sha(stored.data));
          const target = resolveRequestImageTarget(model, ref);
          const variant = await context.attachments.readImageRequest(ref, target);
          return {
            sourceBytes: sources[index]!.length,
            sourceSha256: sha(sources[index]!),
            normalizedBytes: ref.bytes,
            normalizedSha256: sha(stored.data),
            normalizedDimensions: [ref.width, ref.height],
            requestVariantId: variant.variantId,
            requestVariantBytes: variant.bytes,
            requestDimensions: [variant.width, variant.height],
            requestSha256: sha(variant.data),
          };
        }),
      );
    } finally {
      await context.fiber.dispose();
    }
    verifyTransport(
      proxy.evidence,
      storedEvidence.map((image) => image.requestSha256),
      policy,
    );
    cleanupAttempted = true;
    await proxy.cleanup();
    cleaned = true;
    assert.equal(proxy.evidence.deletedUploads, proxy.evidence.uploads.length);
    const result = {
      dshVersion: "0.1.7-rc.2",
      filesPolicy: policy,
      sessionId,
      firstVisionAnswerMatched: true,
      historyAnswerMatched: true,
      wireImagesMatch: true,
      completedTurns: 2,
      toolCalls: 0,
      eventCount: events.length,
      persistedV4: true,
      fullEventsEqual: true,
      sourceImageCount: 2,
      stored: storedEvidence,
      transport: proxy.evidence,
    };
    console.log(JSON.stringify(result, null, 2));
    verified = true;
  } finally {
    let proxyClosed = false;
    let removed = false;
    try {
      if (owner && !closed) {
        await owner.close();
        closed = true;
      }
    } finally {
      try {
        if (proxy && !cleanupAttempted) {
          cleanupAttempted = true;
          await proxy.cleanup();
          cleaned = true;
        }
      } finally {
        try {
          try {
            if (proxy)
              await writeFile(
                join(root, "transport.json"),
                JSON.stringify(proxy.evidence, null, 2),
                { mode: 0o600 },
              );
          } finally {
            if (proxy) {
              await proxy.close();
              proxyClosed = true;
            } else proxyClosed = true;
          }
        } finally {
          try {
            if (verified && closed && cleaned && proxyClosed) {
              await rm(root, { recursive: true, force: true });
              removed = true;
              console.log(JSON.stringify({ localTemporaryDirectoryRemoved: true }));
            }
          } finally {
            if (!removed)
              console.error(
                JSON.stringify({
                  retainedDirectory: root,
                  closed,
                  remoteCleanupConfirmed: cleaned,
                  proxyClosed,
                }),
              );
          }
        }
      }
    }
  }
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      failed: true,
      error: error instanceof Error ? error.name : "UnknownError",
      automaticReplay: false,
    }),
  );
  process.exitCode = 1;
});
