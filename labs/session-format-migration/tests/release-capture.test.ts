import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import LocalStore from "@deepseek-ai/dsh-attachment-local";
import { SessionId } from "@deepseek-ai/dsh-session";
import { expect, test } from "vitest";
import { mountBackend } from "../src/fixture.ts";

test("the release-recorded nonempty V4 session and image object reopen together", async () => {
  const root = await mkdtemp(join(tmpdir(), "hands-on-dsh-release-capture-test-"));
  const source = join(import.meta.dirname, "..", "fixtures", "recorded-v4");
  const ctx = new Context();
  let backend: Context | undefined;
  try {
    await cp(source, root, { recursive: true });
    const metadata = JSON.parse(await readFile(join(root, "metadata.json"), "utf8")) as {
      origin: string;
      formatVersion: number;
      eventCount: number;
      log: string;
      logSha256: string;
      imageObject: string;
      imageSha256: string;
    };
    expect(metadata.origin).toBe("recorded-by-release");
    expect(metadata.formatVersion).toBe(4);
    expect(metadata.eventCount).toBe(6);
    expect(
      createHash("sha256")
        .update(await readFile(join(root, metadata.log)))
        .digest("hex"),
    ).toBe(metadata.logSha256);
    expect(
      createHash("sha256")
        .update(await readFile(join(root, metadata.imageObject)))
        .digest("hex"),
    ).toBe(metadata.imageSha256);
    await ctx.plugin(LocalStore, { dshHome: root });
    backend = await mountBackend(join(root, "sessions"), "zstd");
    const handle = await backend.sessionPersistence.open(SessionId("recorded-v4-image"), "read");
    const { events } = await handle.read();
    expect(handle.header.version).toBe(4);
    await handle.close();
    expect(events.map((event) => event.type)).toEqual([
      "turn/start",
      "step/start",
      "user/message",
      "assistant/message",
      "step/end",
      "turn/end",
    ]);
    const user = events.find((event) => event.type === "user/message");
    expect(user?.type).toBe("user/message");
    if (user?.type !== "user/message") return;
    const image = user.data.content.find((block) => block.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type !== "image") return;
    const stored = await ctx.attachments.readImage(image.attachment);
    expect(image.attachment.attachmentId).toBe(
      `sha256:${createHash("sha256").update(stored.data).digest("hex")}`,
    );
    expect(Buffer.from(stored.data)).toEqual(
      await readFile(ctx.attachments.imageHostPath(image.attachment)!),
    );
  } finally {
    if (backend) await backend.fiber.dispose();
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
