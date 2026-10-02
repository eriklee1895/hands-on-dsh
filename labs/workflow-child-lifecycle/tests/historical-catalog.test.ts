import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import Persistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { SessionId } from "@deepseek-ai/dsh-session";
import { readStored, verifyForest } from "../src/evidence.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ids = {
  parentId: SessionId("historical-parent"),
  childId: SessionId("historical-child"),
  grandchildId: SessionId("historical-grandchild"),
};

it("backfills a V3 forest catalog on read, publishes V4 on write, and preserves every predecessor byte", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-historical-forest-"));
  roots.push(root);
  const sources = [
    [
      ids.parentId,
      await readFile(new URL("../fixtures/historical-v3/parent.jsonl", import.meta.url)),
    ],
    [
      ids.childId,
      await readFile(new URL("../fixtures/historical-v3/child.jsonl", import.meta.url)),
    ],
    [
      ids.grandchildId,
      await readFile(new URL("../fixtures/historical-v3/grandchild.jsonl", import.meta.url)),
    ],
  ] as const;
  const paths = new Map<string, string>();
  const successors = new Map<string, Buffer>();
  for (const [id, bytes] of sources) {
    const directory = join(root, "_no-cwd", id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, "session.v3.jsonl");
    await writeFile(path, bytes);
    paths.set(id, path);
  }
  const ctx = new Context();
  await ctx.plugin(Persistence, { root, compression: "none" });
  let logicalRead: {
    root: Awaited<ReturnType<typeof readStored>>;
    child: Awaited<ReturnType<typeof readStored>>;
    grandchild: Awaited<ReturnType<typeof readStored>>;
  };
  try {
    logicalRead = {
      root: await readStored(root, ids.parentId),
      child: await readStored(root, ids.childId),
      grandchild: await readStored(root, ids.grandchildId),
    };
    expect(logicalRead.root.events.map((event) => event.type)).toEqual(["subagent/catalog"]);
    expect(logicalRead.child.events.map((event) => event.type)).toEqual([
      "subagent/descriptor",
      "subagent/catalog",
    ]);
    expect(logicalRead.grandchild.events.map((event) => event.type)).toEqual([
      "subagent/descriptor",
    ]);
    expect(verifyForest(logicalRead, logicalRead, ids).edges).toBe(2);
    for (const [id, bytes] of sources) {
      expect(await readFile(paths.get(id)!)).toEqual(bytes);
      expect(await readdir(join(root, "_no-cwd", id))).toEqual(["session.v3.jsonl"]);
      const writer = await ctx.sessionPersistence.open(id, "write");
      await writer.close();
      expect(await readFile(paths.get(id)!)).toEqual(bytes);
      expect(
        (await readdir(join(root, "_no-cwd", id)))
          .filter((name) => name.startsWith("session.v"))
          .sort(),
      ).toEqual(["session.v3.jsonl", "session.v4.jsonl"]);
      successors.set(id, await readFile(join(root, "_no-cwd", id, "session.v4.jsonl")));
    }
  } finally {
    await ctx.fiber.dispose();
  }
  const reopened = {
    root: await readStored(root, ids.parentId),
    child: await readStored(root, ids.childId),
    grandchild: await readStored(root, ids.grandchildId),
  };
  expect(verifyForest(logicalRead!, reopened, ids).edges).toBe(2);
  for (const [id, bytes] of sources) {
    expect(await readFile(paths.get(id)!)).toEqual(bytes);
    expect(await readFile(join(root, "_no-cwd", id, "session.v4.jsonl"))).toEqual(
      successors.get(id),
    );
  }
});

it("does not invent a grandchild edge when the historical header names another parent", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-historical-broken-"));
  roots.push(root);
  for (const [id, file] of [
    [ids.parentId, "parent"],
    [ids.childId, "child"],
    [ids.grandchildId, "grandchild"],
  ] as const) {
    const directory = join(root, "_no-cwd", id);
    await mkdir(directory, { recursive: true });
    const source = await readFile(
      new URL(`../fixtures/historical-v3/${file}.jsonl`, import.meta.url),
      "utf8",
    );
    await writeFile(
      join(directory, "session.v3.jsonl"),
      file === "grandchild"
        ? source.replace('"parentSession":"historical-child"', '"parentSession":"stranger"')
        : source,
    );
  }
  const logs = {
    root: await readStored(root, ids.parentId),
    child: await readStored(root, ids.childId),
    grandchild: await readStored(root, ids.grandchildId),
  };
  expect(logs.child.events.filter((event) => event.type === "subagent/catalog")).toHaveLength(0);
  expect(() => verifyForest(logs, logs, ids)).toThrow();
});
