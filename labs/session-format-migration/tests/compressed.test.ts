import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { constants, zstdCompress, zstdDecompress } from "node:zlib";
import { promisify } from "node:util";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, test } from "vitest";
import {
  copySyntheticFixture,
  mountBackend,
  type FixtureCopy,
  type FixtureName,
} from "../src/fixture.ts";

const decompress = promisify(zstdDecompress);
const compress = promisify(zstdCompress);
const copies: FixtureCopy[] = [];
const contexts: Context[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose();
  for (const copy of copies.splice(0)) await copy.cleanup();
});

async function fixture(name: FixtureName): Promise<FixtureCopy> {
  const copy = await copySyntheticFixture(name, "zstd");
  copies.push(copy);
  return copy;
}

async function mount(root: string): Promise<Context> {
  const ctx = await mountBackend(root, "zstd");
  contexts.push(ctx);
  return ctx;
}

async function read(ctx: Context, copy: FixtureCopy, access: "read" | "write") {
  const handle = await ctx.sessionPersistence.open(copy.id, access);
  try {
    return { version: handle.header.version, events: (await handle.read()).events };
  } finally {
    await handle.close();
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function expectHistoricalMeaning(name: FixtureName, events: readonly SessionEvent[]): void {
  expect(events.map((event) => event.type)).toEqual(
    name === "v1"
      ? [
          "turn/start",
          "step/start",
          "system/message",
          "user/message",
          "assistant/message",
          "step/end",
          "turn/end",
        ]
      : ["turn/start", "step/start", "user/message", "assistant/message", "step/end", "turn/end"],
  );
  expect(events.map((event) => event.seq)).toEqual(events.map((_, seq) => seq));
  const user = events.find((event) => event.type === "user/message");
  if (user?.type !== "user/message") throw new Error("missing user message");
  expect(user.data.id).toBe(`${name}-user`);
  expect(user.data.content).toEqual([
    { type: "text", text: `Question from synthetic ${name.toUpperCase()}` },
  ]);
  const assistant = events.find((event) => event.type === "assistant/message");
  if (assistant?.type !== "assistant/message") throw new Error("missing assistant message");
  const answer = `Synthetic ${name.toUpperCase()} answer`;
  expect(assistant.data.message.content).toEqual([{ type: "text", text: answer }]);
  expect(
    assistant.data.stream?.map((item) => (item.type === "chunk" ? item.chunk.type : item.type)),
  ).toEqual(["block-start", "text-chunks", "block-end", "finish"]);
  expect(assistant.data.stream?.[1]).toMatchObject({ type: "text-chunks", texts: [answer] });
  expect(events.at(-2)).toMatchObject({ type: "step/end", data: { turn: 1, step: 1 } });
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    data: { turn: 1, reason: { kind: "completed" } },
  });
}

async function generations(copy: FixtureCopy): Promise<string[]> {
  return (await readdir(copy.directory))
    .filter((name) => /^session\.v\d+\.jsonl\.zstd$/.test(name))
    .sort();
}

describe.each([
  ["v1", "d881a991be26ea439d1886a6ecef8f25b1380cfa6416c299ce4b645f62f0a76d"],
  ["v3", "92b98c232d38a064333512ba7e1e101f4f8132f93988686eaa8d878c6d8af8d3"],
] as const)("compressed synthetic %s history", (name, expectedSha256) => {
  test("migrates nonempty history without rewriting predecessor; fresh backend reads successor", async () => {
    const copy = await fixture(name);
    const before = await readFile(copy.sourcePath);
    expect(digest(before)).toBe(expectedSha256);
    expect(before.readUInt32LE(0)).toBe(0xfd2fb528);
    expect(before[4]! & 0x04).toBe(0x04);
    const plain = await decompress(before);
    expect(plain.toString("utf8")).toContain(`"id":"synthetic-${name}"`);
    const ctx = await mount(copy.root);
    const logical = await read(ctx, copy, "read");
    expect(logical.version).toBe(4);
    expectHistoricalMeaning(name, logical.events);
    const plainCopy = await copySyntheticFixture(name);
    copies.push(plainCopy);
    const plainCtx = await mountBackend(plainCopy.root, "none");
    contexts.push(plainCtx);
    expect(logical).toEqual(await read(plainCtx, plainCopy, "read"));
    expect(await generations(copy)).toEqual([`session.${name}.jsonl.zstd`]);
    expect(digest(await readFile(copy.sourcePath))).toBe(digest(before));

    expect(await read(ctx, copy, "write")).toEqual(logical);
    const successor = copy.generationPath(4);
    const successorBytes = await readFile(successor);
    expect(successorBytes.length).toBeGreaterThan(0);
    expect(await generations(copy)).toEqual([
      `session.${name}.jsonl.zstd`,
      "session.v4.jsonl.zstd",
    ]);
    expect(await readFile(copy.sourcePath)).toEqual(before);
    await ctx.fiber.dispose();
    contexts.splice(contexts.indexOf(ctx), 1);
    const fresh = await mount(copy.root);
    expect(await read(fresh, copy, "read")).toEqual(logical);
    expect(await readFile(successor)).toEqual(successorBytes);
    expect(await readFile(copy.sourcePath)).toEqual(before);
  });

  test("a complete frame with changed compressed bytes is rejected without publication", async () => {
    const copy = await fixture(name);
    const bytes = await readFile(copy.sourcePath);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
    await writeFile(copy.sourcePath, bytes);
    const ctx = await mount(copy.root);
    for (const access of ["read", "write"] as const) {
      await expect(ctx.sessionPersistence.open(copy.id, access)).rejects.toThrow();
    }
    expect(await readFile(copy.sourcePath)).toEqual(bytes);
    expect(await generations(copy)).toEqual([`session.${name}.jsonl.zstd`]);
  });

  test("semantic checks detect missing user text and terminal event", async () => {
    const copy = await fixture(name);
    const ctx = await mount(copy.root);
    const logical = await read(ctx, copy, "read");
    const emptyUserText = logical.events.map((event): SessionEvent =>
      event.type === "user/message"
        ? { ...event, data: { ...event.data, content: [{ type: "text" as const, text: "" }] } }
        : event,
    );
    expect(() => expectHistoricalMeaning(name, emptyUserText)).toThrow();
    const missingTurnEnd = logical.events.filter((event) => event.type !== "turn/end");
    expect(() => expectHistoricalMeaning(name, missingTurnEnd)).toThrow();
  });
});

test("future compressed generation refuses despite a readable V3 predecessor", async () => {
  const copy = await fixture("v3");
  const source = await readFile(copy.sourcePath);
  const future = copy.generationPath(5);
  const futureBytes = await compress(
    `${JSON.stringify({
      type: "session",
      version: 5,
      id: copy.id,
      createdAt: 2000,
      isSeeded: false,
      delegationDepth: 0,
    })}\n`,
    { params: { [constants.ZSTD_c_checksumFlag]: 1 } },
  );
  expect(JSON.parse((await decompress(futureBytes)).toString("utf8")).version).toBe(5);
  await writeFile(future, futureBytes);
  const ctx = await mount(copy.root);
  for (const access of ["read", "write"] as const) {
    await expect(ctx.sessionPersistence.open(copy.id, access)).rejects.toThrow(
      /uses log format v5.*upgrade the harness/,
    );
  }
  expect(await readFile(copy.sourcePath)).toEqual(source);
  expect(await readFile(future)).toEqual(futureBytes);
  expect(await generations(copy)).toEqual(["session.v3.jsonl.zstd", "session.v5.jsonl.zstd"]);
});

test("a corrupt highest compressed V4 refuses without fallback to retained V3", async () => {
  const copy = await fixture("v3");
  const source = await readFile(copy.sourcePath);
  const first = await mount(copy.root);
  await read(first, copy, "write");
  await first.fiber.dispose();
  contexts.splice(contexts.indexOf(first), 1);
  const successor = copy.generationPath(4);
  const corrupt = await readFile(successor);
  corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 0x01;
  await writeFile(successor, corrupt);
  const fresh = await mount(copy.root);
  for (const access of ["read", "write"] as const) {
    await expect(fresh.sessionPersistence.open(copy.id, access)).rejects.toThrow();
  }
  expect(await readFile(copy.sourcePath)).toEqual(source);
  expect(await readFile(successor)).toEqual(corrupt);
  expect(await generations(copy)).toEqual(["session.v3.jsonl.zstd", "session.v4.jsonl.zstd"]);
});
