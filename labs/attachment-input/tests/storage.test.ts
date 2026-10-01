import { Context } from "@deepseek-ai/cordis";
import LocalStore from "@deepseek-ai/dsh-attachment-local";
import { admitEncodedImages } from "@deepseek-ai/dsh-attachment";
import { mkdtemp, rm, chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { it, expect } from "vitest";
import { grid, COLORS } from "../src/fixture.ts";
async function withStore(
  body: (ctx: Context, root: string) => Promise<void>,
  options: object = {},
) {
  const root = await mkdtemp(join(tmpdir(), "dsh-attachment-test-"));
  const ctx = new Context();
  try {
    await ctx.plugin(LocalStore, { dshHome: root, ...options });
    await body(ctx, root);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
}
it("deduplicates admitted bytes across names and preserves old reads after tighter admission limits", async () => {
  await withStore(async (ctx, root) => {
    const data = await grid(COLORS, 64, 64);
    const [first, second] = await admitEncodedImages(ctx.attachments, [
      { data: data.toString("base64"), mediaType: "image/png", name: "one.png" },
      { data: data.toString("base64"), mediaType: "image/png", name: "two.png" },
    ]);
    expect(first!.attachmentId).toBe(second!.attachmentId);
    expect(first!.name).not.toBe(second!.name);
    expect(ctx.attachments.imageHostPath(first!)).toBe(ctx.attachments.imageHostPath(second!));
    expect(Buffer.from((await ctx.attachments.readImage(first!)).data)).toEqual(data);
    await ctx.fiber.dispose();
    const reopened = new Context();
    try {
      await reopened.plugin(LocalStore, { dshHome: root, maxImageBytes: 1 });
      expect(Buffer.from((await reopened.attachments.readImage(first!)).data)).toEqual(data);
      await expect(
        reopened.attachments.saveImage({ data, mediaType: "image/png" }),
      ).rejects.toMatchObject({ code: "IMAGE_TOO_LARGE" });
    } finally {
      await reopened.fiber.dispose();
    }
  });
});
it("normalizes to a bounded opaque raster and records original dimensions", async () => {
  await withStore(
    async (ctx) => {
      const source = await grid(COLORS, 512, 256);
      const ref = await ctx.attachments.saveImage({ data: source, mediaType: "image/png" });
      const stored = await ctx.attachments.readImage(ref);
      const meta = await sharp(stored.data).metadata();
      expect(ref).toMatchObject({
        width: 128,
        height: 64,
        mediaType: "image/jpeg",
        originalDimensions: { width: 512, height: 256 },
      });
      expect(meta.width).toBe(128);
      expect(meta.height).toBe(64);
      expect(meta.exif).toBeUndefined();
      expect(ref.attachmentId).toBe(
        "sha256:" + createHash("sha256").update(stored.data).digest("hex"),
      );
      expect(Buffer.from(stored.data)).not.toEqual(source);
    },
    { normalizedImageMaxPixels: 8192, normalizedImageMaxDimension: 128 },
  );
});
it("regenerates identical request variants after deleting only the owned cache", async () => {
  await withStore(async (ctx, root) => {
    const ref = await ctx.attachments.saveImage({
      data: await grid(COLORS, 256, 128),
      mediaType: "image/png",
    });
    const original = await ctx.attachments.readImage(ref);
    const target = { width: 64, height: 32, maxBytes: 4096 };
    const a = await ctx.attachments.readImageRequest(ref, target);
    const b = await ctx.attachments.readImageRequest(ref, target);
    expect(a.variantId).toBe(b.variantId);
    expect(a.data).toEqual(b.data);
    expect([a.width, a.height]).toEqual([64, 32]);
    await rm(join(root, "cache"), { recursive: true, force: true });
    const c = await ctx.attachments.readImageRequest(ref, target);
    expect(c.variantId).toBe(a.variantId);
    expect(c.data).toEqual(a.data);
    expect((await ctx.attachments.readImage(ref)).data).toEqual(original.data);
  });
});
it("rejects noncanonical base64, wrong MIME and a refused batch", async () => {
  await withStore(
    async (ctx) => {
      const data = await grid(COLORS, 64, 64);
      await expect(
        admitEncodedImages(ctx.attachments, [
          { data: data.toString("base64") + "\n", mediaType: "image/png" },
        ]),
      ).rejects.toMatchObject({ code: "INVALID_IMAGE_BASE64" });
      await expect(
        ctx.attachments.saveImage({ data, mediaType: "image/jpeg" }),
      ).rejects.toMatchObject({ code: "IMAGE_TYPE_MISMATCH" });
      await expect(
        ctx.attachments.saveImages([
          { data, mediaType: "image/png" },
          { data, mediaType: "image/png" },
        ]),
      ).rejects.toMatchObject({ code: "TOO_MANY_IMAGES" });
    },
    { maxImagesPerMessage: 1 },
  );
});
it("refuses same-length corrupted durable bytes instead of returning an image", async () => {
  await withStore(async (ctx) => {
    const ref = await ctx.attachments.saveImage({
      data: await grid(COLORS, 64, 64),
      mediaType: "image/png",
    });
    const path = ctx.attachments.imageHostPath(ref)!;
    const bytes = await readFile(path);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    await chmod(path, 0o600);
    await writeFile(path, bytes);
    await expect(ctx.attachments.readImage(ref)).rejects.toMatchObject({
      code: "ATTACHMENT_CORRUPT",
    });
  });
});
