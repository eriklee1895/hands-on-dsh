import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import { EXPECTED_DSH_REVISION } from "../src/runtime-launch.ts";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];
const tutorialRoot = join(import.meta.dirname, "..");
const runtimeRoot = join(tutorialRoot, ".runtime");
const fakeRuntime = join(import.meta.dirname, "fixtures/fake-runtime.mjs");

async function listRuntimeState(): Promise<string[]> {
  try {
    return (await readdir(runtimeRoot)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function fakeSource(): Promise<{ env: NodeJS.ProcessEnv; root: string; key: string }> {
  const base = await mkdtemp(join(tmpdir(), "dsh-ts-cli-"));
  temporaryRoots.push(base);
  const root = join(base, "source");
  const fakeBin = join(base, "bin");
  await mkdir(join(root, "packages/examples/jsonrpc-demo/lib"), { recursive: true });
  await mkdir(join(root, "examples/jsonrpc-agent"), { recursive: true });
  await mkdir(fakeBin);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module", version: "0.1.1-rc.2" }),
  );
  await copyFile(fakeRuntime, join(root, "packages/examples/jsonrpc-demo/lib/bin.js"));
  await writeFile(join(root, "examples/jsonrpc-agent/minimal.cordis.yml"), "[]\n");
  const git = join(fakeBin, "git");
  await writeFile(
    git,
    `#!/bin/sh
if [ "$1" != "-C" ]; then exit 90; fi
shift 2
if [ "$1" = "diff" ]; then exit 0; fi
if [ "$1" = "rev-parse" ]; then printf '%s\\n' "${EXPECTED_DSH_REVISION}"; exit 0; fi
exit 2
`,
  );
  await chmod(git, 0o755);
  const key = "fake-cli-key-must-never-appear";
  return {
    root,
    key,
    env: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      DSH_SOURCE_ROOT: root,
      DEEPSEEK_API_KEY: key,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("example CLIs", () => {
  test.each([
    "01_explicit_launch.ts",
    "02_reuse_session.ts",
    "03_notification_stream.ts",
    "04_low_level_client.ts",
  ])("%s has keyless help with no credential or personal path leakage", async (file) => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", `examples/${file}`, "--help"],
      {
        cwd: tutorialRoot,
        env: { PATH: process.env.PATH },
      },
    );
    expect(stderr).toBe("");
    expect(stdout).toContain("用法");
    expect(stdout).not.toMatch(/DEEPSEEK_API_KEY\s*=\s*\S+/);
    expect(stdout).not.toContain("/Users/");
  });

  test.each([
    "/Users/example/missing",
    "/Volumes/example/missing",
    "/private/var/example/missing",
    "/mnt/example/missing",
    "/home/example/missing",
  ])("a parse failure sanitizes bounded local path diagnostics for %s", async (sourceRoot) => {
    const key = "fake-failure-key-must-never-appear";
    await expect(
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "examples/01_explicit_launch.ts", sourceRoot],
        {
          cwd: tutorialRoot,
          env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: key },
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.not.stringContaining(sourceRoot),
    });
  });

  test("a source-validation launch failure is typed without stack, path, or credential leakage", async () => {
    const sourceRoot = "/private/var/hands-on-dsh-missing-source";
    const key = "fake-launch-key-must-never-appear";
    await expect(
      execFileAsync(
        process.execPath,
        ["--import", "tsx", "examples/01_explicit_launch.ts", "--source-root", sourceRoot],
        {
          cwd: tutorialRoot,
          env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: key },
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.not.stringMatching(new RegExp(`${sourceRoot}|${key}|at validateSource`)),
    });
  });

  test("a parse failure never prints an injected credential", async () => {
    const key = "fake-parse-key-must-never-appear";
    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", "examples/01_explicit_launch.ts", key], {
        cwd: tutorialRoot,
        env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: key },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.not.stringContaining(key),
    });
  });

  test.each([
    ["01_explicit_launch.ts", []],
    [
      "02_reuse_session.ts",
      ["--prompt", "Remember amber.", "--second-prompt", "What did I ask you to remember?"],
    ],
    ["03_notification_stream.ts", []],
    ["04_low_level_client.ts", []],
  ])("%s completes a successful keyless fake-runtime orchestration", async (file, args) => {
    const fixture = await fakeSource();
    const before = await listRuntimeState();
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", `examples/${file}`, ...args],
      { cwd: tutorialRoot, env: fixture.env, timeout: 5_000 },
    );
    expect(stderr).toBe("");
    expect(stdout).not.toContain(fixture.key);
    expect(stdout).not.toContain(fixture.root);
    expect(stdout).not.toMatch(/\/(?:Users|Volumes|private\/var|mnt|home)\//);
    expect(await listRuntimeState()).toEqual(before);
    if (file === "03_notification_stream.ts") {
      expect(JSON.parse(stdout)).toMatchObject({ proof: { verified: true } });
    }
  });
});
