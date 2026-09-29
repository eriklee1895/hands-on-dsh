import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import {
  copySyntheticFixture,
  mountBackend,
  type FixtureCopy,
  type FixtureName,
} from "../src/fixture.ts";

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function generations(files: string[]): string[] {
  return files.filter((name) => /^session\.v\d+\.jsonl$/.test(name)).sort();
}

async function read(ctx: Context, fixture: FixtureCopy, access: "read" | "write") {
  const handle = await ctx.sessionPersistence.open(fixture.id, access);
  try {
    return { version: handle.header.version, events: (await handle.read()).events };
  } finally {
    await handle.close();
  }
}

function messageText(events: readonly SessionEvent[]): string {
  const message = events.find((event) => event.type === "assistant/message");
  if (message?.type !== "assistant/message") return "";
  return message.data.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function demonstrate(name: FixtureName): Promise<void> {
  const fixture = await copySyntheticFixture(name);
  let ctx: Context | undefined;
  let reopened: Context | undefined;
  try {
    const sourceBefore = await readFile(fixture.sourcePath);
    const initialNames = generations(await readdir(fixture.directory));
    ctx = await mountBackend(fixture.root, "none");
    const logical = await read(ctx, fixture, "read");
    const readOnlyNames = generations(await readdir(fixture.directory));
    const published = await read(ctx, fixture, "write");
    const successorPath = fixture.generationPath(4);
    const successorBeforeReopen = await readFile(successorPath);
    const writtenNames = generations(await readdir(fixture.directory));
    await ctx.fiber.dispose();
    ctx = undefined;
    reopened = await mountBackend(fixture.root, "none");
    const logicalAgain = await read(reopened, fixture, "read");
    const sourceAfter = await readFile(fixture.sourcePath);
    const successorAfterReopen = await readFile(successorPath);
    const assistant = logical.events.find((event) => event.type === "assistant/message");
    const embeddedStreamItems =
      assistant?.type === "assistant/message" ? (assistant.data.stream?.length ?? 0) : 0;
    process.stdout.write(
      JSON.stringify(
        {
          fixture: name,
          release: "0.1.7-rc.2",
          sourceVersion: fixture.version,
          logicalVersion: logical.version,
          eventTypes: logical.events.map((event) => event.type),
          assistantText: messageText(logical.events),
          embeddedStreamItems,
          sourceSha256Before: hash(sourceBefore),
          sourceSha256After: hash(sourceAfter),
          sourceBytesUnchanged: sourceBefore.equals(sourceAfter),
          initialGenerations: initialNames,
          readOnlyGenerations: readOnlyNames,
          afterWriteGenerations: writtenNames,
          successorSha256: hash(successorBeforeReopen),
          successorBytesStable: successorBeforeReopen.equals(successorAfterReopen),
          logicalReopenStable:
            JSON.stringify(logicalAgain) === JSON.stringify(logical) &&
            JSON.stringify(published) === JSON.stringify(logical),
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    if (reopened !== undefined) await reopened.fiber.dispose();
    if (ctx !== undefined) await ctx.fiber.dispose();
    await fixture.cleanup();
  }
}

const name = process.argv[2] ?? "v1";
if (name !== "v1" && name !== "v3") {
  throw new Error("fixture must be v1 or v3; this lab accepts no external data path");
}
await demonstrate(name);
