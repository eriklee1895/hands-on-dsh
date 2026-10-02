import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, test } from "vitest";
import {
  copySyntheticFixture,
  mountBackend,
  type FixtureCopy,
  type FixtureName,
} from "../src/fixture.ts";

const copies: FixtureCopy[] = [];
const contexts: Context[] = [];
const freshRoots: string[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const copy of copies.splice(0)) await copy.cleanup();
  for (const root of freshRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(name: FixtureName): Promise<FixtureCopy> {
  const copy = await copySyntheticFixture(name);
  copies.push(copy);
  return copy;
}

async function mounted(root: string): Promise<Context> {
  const ctx = await mountBackend(root, "none");
  contexts.push(ctx);
  return ctx;
}

async function readAll(ctx: Context, copy: FixtureCopy, access: "read" | "write") {
  const handle = await ctx.sessionPersistence.open(copy.id, access);
  try {
    return { version: handle.header.version, events: (await handle.read()).events };
  } finally {
    await handle.close();
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assistantText(events: readonly SessionEvent[]): string | undefined {
  const event = events.find((item) => item.type === "assistant/message");
  if (event?.type !== "assistant/message") return undefined;
  return event.data.message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

describe.each([
  ["v1", "Synthetic V1 answer"],
  ["v3", "Synthetic V3 answer"],
] as const)("synthetic %s physical generation", (name, expectedAnswer) => {
  test("read is logical V4 without publication; write publishes immutable V4 and reopen is stable", async () => {
    const copy = await fixture(name);
    const before = await readFile(copy.sourcePath);
    const beforeNames = (await readdir(copy.directory)).sort();
    const ctx = await mounted(copy.root);
    const read = await readAll(ctx, copy, "read");
    expect(read.version).toBe(4);
    expect(read.events.length).toBeGreaterThan(0);
    expect(assistantText(read.events)).toBe(expectedAnswer);
    expect(read.events.map((event) => event.type)).not.toContain("assistant/chunk");
    if (name === "v1") {
      const assistant = read.events.find((event) => event.type === "assistant/message");
      expect(assistant?.type).toBe("assistant/message");
      if (assistant?.type === "assistant/message") {
        expect(assistant.data.stream?.length).toBeGreaterThan(0);
      }
    }
    expect(await readFile(copy.sourcePath)).toEqual(before);
    expect((await readdir(copy.directory)).sort()).toEqual(beforeNames);

    const written = await readAll(ctx, copy, "write");
    expect(written.events).toEqual(read.events);
    const successor = copy.generationPath(4);
    const successorBefore = await readFile(successor);
    expect(successorBefore.length).toBeGreaterThan(0);
    expect(await readFile(copy.sourcePath)).toEqual(before);
    expect(sha256(await readFile(copy.sourcePath))).toBe(sha256(before));
    expect(
      (await readdir(copy.directory)).filter((file) => file.startsWith("session.v")).sort(),
    ).toEqual([name === "v1" ? "session.v1.jsonl" : "session.v3.jsonl", "session.v4.jsonl"]);

    await ctx.fiber.dispose();
    contexts.splice(contexts.indexOf(ctx), 1);
    const reopened = await mounted(copy.root);
    const again = await readAll(reopened, copy, "read");
    expect(again).toEqual(read);
    expect(await readFile(successor)).toEqual(successorBefore);
    expect(await readFile(copy.sourcePath)).toEqual(before);
  });
});

test("a future highest generation refuses read and write without falling back or publishing", async () => {
  const copy = await fixture("v1");
  const future = copy.generationPath(5);
  await writeFile(
    future,
    JSON.stringify({
      type: "session",
      version: 5,
      id: copy.id,
      createdAt: 1000,
      isSeeded: false,
      delegationDepth: 0,
    }) + "\n",
  );
  const sourceBefore = await readFile(copy.sourcePath);
  const futureBefore = await readFile(future);
  const generationsBefore = (await readdir(copy.directory))
    .filter((name) => name.startsWith("session.v"))
    .sort();
  const ctx = await mounted(copy.root);
  for (const access of ["read", "write"] as const) {
    await expect(ctx.sessionPersistence.open(copy.id, access)).rejects.toThrow();
  }
  expect(await readFile(copy.sourcePath)).toEqual(sourceBefore);
  expect(await readFile(future)).toEqual(futureBefore);
  expect(
    (await readdir(copy.directory)).filter((name) => name.startsWith("session.v")).sort(),
  ).toEqual(generationsBefore);
});

test("a corrupt highest V4 generation refuses without falling back to valid V3", async () => {
  const copy = await fixture("v3");
  const ctx = await mounted(copy.root);
  await readAll(ctx, copy, "write");
  await ctx.fiber.dispose();
  contexts.splice(contexts.indexOf(ctx), 1);
  const successor = copy.generationPath(4);
  const header = (await readFile(successor, "utf8")).split("\n")[0];
  await writeFile(
    successor,
    header + "\n" + '{"type":"assistant/message","seq":0,"time":1,"data":{}}\n',
  );
  const sourceBefore = await readFile(copy.sourcePath);
  const corruptBefore = await readFile(successor);
  const generationsBefore = (await readdir(copy.directory))
    .filter((name) => name.startsWith("session.v"))
    .sort();
  const fresh = await mounted(copy.root);
  for (const access of ["read", "write"] as const) {
    await expect(fresh.sessionPersistence.open(copy.id, access)).rejects.toThrow();
  }
  expect(await readFile(copy.sourcePath)).toEqual(sourceBefore);
  expect(await readFile(successor)).toEqual(corruptBefore);
  expect(
    (await readdir(copy.directory)).filter((name) => name.startsWith("session.v")).sort(),
  ).toEqual(generationsBefore);
});

test("publishing V4 leaves both existing V1 and selected V3 generations byte-identical", async () => {
  const copy = await fixture("v3");
  const lower = copy.generationPath(1);
  const releasedV1 = await readFile(
    join(import.meta.dirname, "..", "fixtures", "synthetic-v1.jsonl"),
    "utf8",
  );
  const lines = releasedV1.split("\n");
  const header = JSON.parse(lines[0]!) as { id: string };
  header.id = copy.id;
  lines[0] = JSON.stringify(header);
  await writeFile(lower, lines.join("\n"));
  const v1Before = await readFile(lower);
  const v3Before = await readFile(copy.sourcePath);
  const ctx = await mounted(copy.root);
  const result = await readAll(ctx, copy, "write");
  expect(assistantText(result.events)).toBe("Synthetic V3 answer");
  expect(await readFile(lower)).toEqual(v1Before);
  expect(await readFile(copy.sourcePath)).toEqual(v3Before);
  expect(
    (await readdir(copy.directory)).filter((name) => name.startsWith("session.v")).sort(),
  ).toEqual(["session.v1.jsonl", "session.v3.jsonl", "session.v4.jsonl"]);
});

test("unsupported historical body refuses without publishing or changing its source", async () => {
  const copy = await fixture("v1");
  const text = await readFile(copy.sourcePath, "utf8");
  await writeFile(
    copy.sourcePath,
    text.replace('"type":"assistant/chunk"', '"type":"future/chunk"'),
  );
  const sourceBefore = await readFile(copy.sourcePath);
  const ctx = await mounted(copy.root);
  for (const access of ["read", "write"] as const) {
    await expect(ctx.sessionPersistence.open(copy.id, access)).rejects.toThrow();
  }
  expect(await readFile(copy.sourcePath)).toEqual(sourceBefore);
  expect((await readdir(copy.directory)).filter((name) => name.startsWith("session.v"))).toEqual([
    "session.v1.jsonl",
  ]);
});

test("public default Zstd encoding materializes a fresh V4 header", async () => {
  const root = await mkdtemp(join(tmpdir(), "hands-on-dsh-current-zstd-"));
  freshRoots.push(root);
  const ctx = await mountBackend(root);
  contexts.push(ctx);
  const id = SessionId("fresh-zstd");
  const writer = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 3000,
    isSeeded: false,
  });
  try {
    await writer.flush();
  } finally {
    await writer.close();
  }
  const physical = join(root, "_no-cwd", id, "session.v4.jsonl.zstd");
  expect((await readFile(physical)).length).toBeGreaterThan(0);
  const reader = await ctx.sessionPersistence.open(id, "read");
  try {
    expect(reader.header.version).toBe(4);
    expect((await reader.read()).events).toEqual([]);
  } finally {
    await reader.close();
  }
});
