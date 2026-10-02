import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { parseInput, runWorker, type ProbeInput } from "../src/worker.ts";

interface Fixture {
  input: ProbeInput;
  root: string;
  temp: string;
  server: Server;
  closeServer(): Promise<void>;
}

const fixtures: Fixture[] = [];

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "sandbox-worker-owned-"));
  const temp = await mkdtemp(join(tmpdir(), "sandbox-worker-temp-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const nonce = "fixture-" + process.pid;
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, "canary.txt"), nonce);
  await symlink(join(outside, "symlink.txt"), join(workspace, "outside-link.txt"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(nonce);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("loopback did not bind");
  let closed = false;
  const fixture: Fixture = {
    root,
    temp,
    server,
    input: {
      workspace,
      outside,
      temp,
      url: "http://127.0.0.1:" + address.port + "/probe",
      parentPid: process.pid,
      nonce,
    },
    async closeServer() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.closeServer();
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.temp, { recursive: true, force: true });
  }
});

test("unrestricted worker performs exactly its owned operations and reports exact loopback/canary", async () => {
  const fixture = await makeFixture();
  const parsed = parseInput(JSON.stringify(fixture.input));
  expect(parsed).toEqual(fixture.input);
  const report = await runWorker(parsed);
  expect(report.nonce).toBe(fixture.input.nonce);
  expect(Object.keys(report.operations).sort()).toEqual([
    "descendantWrite",
    "insideWrite",
    "loopback",
    "outsideRead",
    "outsideWrite",
    "parentVisible",
    "symlinkWrite",
    "tempWrite",
  ]);
  for (const operation of Object.values(report.operations)) {
    expect(operation.status).toBe("allowed");
    expect(operation.code).toBeUndefined();
  }
  expect(report.operations.outsideRead.value).toBe(fixture.input.nonce);
  expect(report.operations.loopback.value).toBe(fixture.input.nonce);
  for (const path of [
    join(fixture.input.workspace, "inside.txt"),
    join(fixture.input.outside, "outside.txt"),
    join(fixture.input.outside, "symlink.txt"),
    join(fixture.input.outside, "descendant.txt"),
    join(fixture.input.temp, "temp.txt"),
  ]) {
    expect(await readFile(path, "utf8")).toBe(fixture.input.nonce);
  }
});

test("input parser rejects malformed JSON, missing/extra fields, relative paths and unsafe targets", () => {
  const valid = {
    workspace: "/tmp/owned-workspace",
    outside: "/tmp/owned-outside",
    temp: "/tmp/owned-temp",
    url: "http://127.0.0.1:32123/probe",
    parentPid: process.pid,
    nonce: "nonce",
  };
  expect(() => parseInput("{not json")).toThrow();
  for (const invalid of [
    {},
    { ...valid, extra: "not allowed" },
    { ...valid, workspace: "relative" },
    { ...valid, outside: "relative" },
    { ...valid, temp: "relative" },
    { ...valid, url: "http://localhost:32123/probe" },
    { ...valid, url: "http://8.8.8.8:32123/probe" },
    { ...valid, url: "https://127.0.0.1:32123/probe" },
    { ...valid, url: "http://127.0.0.1/probe" },
    { ...valid, url: "http://user@127.0.0.1:32123/probe" },
    { ...valid, parentPid: 0 },
    { ...valid, parentPid: -1 },
    { ...valid, parentPid: 1.5 },
    { ...valid, nonce: "" },
    { ...valid, nonce: "   " },
  ]) {
    expect(() => parseInput(JSON.stringify(invalid))).toThrow();
  }
});

test("missing canary and missing symlink are probe errors, never reported as denied", async () => {
  const fixture = await makeFixture();
  await rm(join(fixture.input.outside, "canary.txt"));
  await expect(runWorker(fixture.input)).rejects.toThrow();
  await writeFile(join(fixture.input.outside, "canary.txt"), fixture.input.nonce);
  await rm(join(fixture.input.workspace, "outside-link.txt"));
  await expect(runWorker(fixture.input)).rejects.toThrow();
});

test("loopback connection refusal is an error rather than a sandbox denial", async () => {
  const fixture = await makeFixture();
  await fixture.closeServer();
  await expect(runWorker(fixture.input)).rejects.toThrow();
});

test("non-directory target raises ENOTDIR rather than a denial report", async () => {
  const fixture = await makeFixture();
  const blockedParent = join(fixture.root, "file-instead-of-workspace");
  await writeFile(blockedParent, "owned");
  await expect(runWorker({ ...fixture.input, workspace: blockedParent })).rejects.toThrow();
});
