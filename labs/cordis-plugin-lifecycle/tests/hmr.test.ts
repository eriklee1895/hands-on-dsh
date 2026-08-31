import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
const projectRoot = join(import.meta.dirname, "..");

async function hmrNodeCandidates(): Promise<string[]> {
  const configured = process.env.STAGE4_HMR_NODE;
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";").map((value) => value.toLowerCase())
      : [""];
  const pathCandidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => join(directory, `node${extension}`)));
  const raw = configured === undefined ? [process.execPath, ...pathCandidates] : [configured];
  const candidates: string[] = [];
  for (const candidate of raw.filter(Boolean)) {
    if (!isAbsolute(candidate)) throw new Error("every HMR Node candidate must be absolute");
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      if (configured !== undefined) throw error;
      continue;
    }
    const canonical = await realpath(candidate);
    if (!candidates.includes(canonical)) candidates.push(canonical);
  }
  return candidates;
}

type Exit = { code: number | null; signal: NodeJS.Signals | null };

function exitPromise(child: ChildProcess): Promise<Exit> {
  return new Promise((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

async function terminate(child: ChildProcess, exited: Promise<Exit>): Promise<Exit> {
  child.kill("SIGTERM");
  const graceful = await within(exited, 1_000);
  if (graceful !== undefined) return graceful;
  child.kill("SIGKILL");
  const forced = await within(exited, 1_000);
  if (forced === undefined) throw new Error("HMR child did not report exit after SIGKILL");
  return forced;
}

async function waitForContent(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(path, "utf8")) === expected) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${expected}`);
}

function probeSource(generation: string): string {
  return `import { appendFileSync } from "node:fs";
import { join } from "node:path";
export const name = "proof-journal-hmr-probe";
export function apply(ctx, config) {
  const log = join(process.cwd(), "lifecycle.log");
  appendFileSync(log, "apply:${generation}:" + config.label + "\\n");
  ctx.effect(() => () => appendFileSync(log, "dispose:${generation}:" + config.label + "\\n"));
}
`;
}

function config(label: string): string {
  return `- id: logger
  name: '@deepseek-ai/cordis-plugin-logger-console'
- id: timer
  name: '@deepseek-ai/cordis-plugin-timer'
- id: hmr
  name: '@deepseek-ai/cordis-plugin-hmr'
  config:
    root: ['.']
- id: probe
  name: './probe.ts'
  config:
    label: '${label}'
- id: ready
  name: './ready.ts'
`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runHmrAttempt(hmrNode: string): Promise<void> {
  await mkdir(join(projectRoot, ".runtime"), { recursive: true });
  const root = await mkdtemp(join(projectRoot, ".runtime", "hmr-"));
  roots.push(root);
  await writeFile(join(root, "probe.ts"), probeSource("v1"));
  await writeFile(
    join(root, "ready.ts"),
    `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export const name = "proof-journal-hmr-ready";
export const inject = ["hmr"];
export function apply() { writeFileSync(join(process.cwd(), "ready"), "ready\\n", { flag: "wx" }); }
`,
  );
  await writeFile(join(root, "cordis.yml"), config("alpha"));

  const child = spawn(hmrNode, ["--import", "tsx", join(projectRoot, "scripts/hmr-child.ts")], {
    cwd: root,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = exitPromise(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForContent(join(root, "ready"), "ready\n");
    await waitForContent(join(root, "lifecycle.log"), "apply:v1:alpha\n");
    await writeFile(join(root, "probe.ts"), probeSource("v2"));
    await waitForContent(
      join(root, "lifecycle.log"),
      "apply:v1:alpha\ndispose:v1:alpha\napply:v2:alpha\n",
    );
    await writeFile(join(root, "cordis.yml"), config("beta"));
    await waitForContent(
      join(root, "lifecycle.log"),
      "apply:v1:alpha\ndispose:v1:alpha\napply:v2:alpha\ndispose:v2:alpha\napply:v2:beta\n",
    );
  } finally {
    await terminate(child, exited);
  }
  expect(stderr).toBe("");
}

test("stable-id Loader HMR disposes before one file and config reactivation", async () => {
  const failures: Error[] = [];
  for (const candidate of await hmrNodeCandidates()) {
    const version = execFileSync(candidate, ["--version"], { encoding: "utf8" }).trim();
    try {
      await runHmrAttempt(candidate);
      return;
    } catch (error) {
      failures.push(
        new Error(
          `HMR attempt failed with ${version}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  throw new AggregateError(failures, "every selected HMR Node executable failed");
});
