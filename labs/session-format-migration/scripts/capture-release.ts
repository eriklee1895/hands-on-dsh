import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import LocalStore from "@deepseek-ai/dsh-attachment-local";
import {
  SESSION_FORMAT_VERSION,
  SessionId,
  SessionSeq,
  type SessionEvent,
} from "@deepseek-ai/dsh-session";
import { mountBackend } from "../src/fixture.ts";

const id = SessionId("recorded-v4-image");
const tempRoot = await mkdtemp(join(tmpdir(), "hands-on-dsh-release-capture-"));
const outputRoot = join(import.meta.dirname, "..", "fixtures", "recorded-v4");
const attachmentContext = new Context();
let backend: Context | undefined;
try {
  await attachmentContext.plugin(LocalStore, { dshHome: tempRoot });
  backend = await mountBackend(join(tempRoot, "sessions"), "zstd");
  const png = await readFile(join(import.meta.dirname, "..", "fixtures", "one-pixel.png"));
  const attachment = await attachmentContext.attachments.saveImage({
    data: png,
    mediaType: "image/png",
    name: "one-pixel.png",
  });
  const events: SessionEvent[] = [
    { type: "turn/start", seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: "step/start", seq: SessionSeq(1), time: 2, data: { turn: 1, step: 1 } },
    {
      type: "user/message",
      seq: SessionSeq(2),
      time: 3,
      surfaceOp: "append",
      data: {
        id: "recorded-user",
        role: "user",
        source: { kind: "user" },
        content: [
          { type: "text", text: "Describe the attached one-pixel sample." },
          { type: "image", attachment },
        ],
      },
    },
    {
      type: "assistant/message",
      seq: SessionSeq(3),
      time: 4,
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "recorded-assistant",
          role: "assistant",
          source: { kind: "model", provider: "fixture", model: "fixture" },
          content: [{ type: "text", text: "A one-pixel sample is attached." }],
        },
      },
    },
    { type: "step/end", seq: SessionSeq(4), time: 5, data: { turn: 1, step: 1 } },
    {
      type: "turn/end",
      seq: SessionSeq(5),
      time: 6,
      data: { turn: 1, reason: { kind: "completed" } },
    },
  ];
  const writer = await backend.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 1000,
    isSeeded: false,
  });
  try {
    await writer.append(events);
    await writer.flush();
  } finally {
    await writer.close();
  }
  await backend.fiber.dispose();
  backend = undefined;
  const fresh = await mountBackend(join(tempRoot, "sessions"), "zstd");
  try {
    const reader = await fresh.sessionPersistence.open(id, "read");
    try {
      if ((await reader.read()).events.length !== events.length)
        throw new Error("release reopen lost events");
    } finally {
      await reader.close();
    }
  } finally {
    await fresh.fiber.dispose();
  }

  const logRelative = join("sessions", "_no-cwd", id, "session.v4.jsonl.zstd");
  const imagePath = attachmentContext.attachments.imageHostPath(attachment);
  if (imagePath === undefined) throw new Error("public store did not expose the image object path");
  const imageRelative = relative(tempRoot, imagePath);
  if (imageRelative.startsWith("..")) throw new Error("image object escaped isolated root");
  await rm(outputRoot, { recursive: true, force: true });
  for (const file of [logRelative, imageRelative]) {
    await mkdir(dirname(join(outputRoot, file)), { recursive: true });
    await copyFile(join(tempRoot, file), join(outputRoot, file));
  }
  const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
  const metadata = {
    origin: "recorded-by-release",
    packages: {
      "@deepseek-ai/dsh-session-persistence-jsonl": "0.1.7-rc.2",
      "@deepseek-ai/dsh-attachment-local": "0.1.7-rc.2",
    },
    formatVersion: SESSION_FORMAT_VERSION,
    compression: "zstd",
    eventCount: events.length,
    log: logRelative,
    logSha256: sha(await readFile(join(outputRoot, logRelative))),
    imageObject: imageRelative,
    imageSha256: sha(await readFile(join(outputRoot, imageRelative))),
    attachmentId: attachment.attachmentId,
  };
  await writeFile(join(outputRoot, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(metadata, null, 2)}\n`);
} finally {
  if (backend) await backend.fiber.dispose();
  await attachmentContext.fiber.dispose();
  await rm(tempRoot, { recursive: true, force: true });
}
