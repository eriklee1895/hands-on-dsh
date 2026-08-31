import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  EXPECTED_DSH_REVISION,
  cleanupRuntimeState,
  resolveRuntimeLaunch,
} from "../src/runtime-launch.ts";

const temporaryRoots: string[] = [];

async function fixture(overrides: Record<string, string> = {}): Promise<{
  parentEnv: NodeJS.ProcessEnv;
  runtimeRoot: string;
  sourceRoot: string;
}> {
  const base = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "dsh-ts-launch-")),
  );
  temporaryRoots.push(base);
  const sourceRoot = join(base, "source");
  const runtimeRoot = join(base, "runtime");
  const fakeBin = join(base, "bin");
  await mkdir(join(sourceRoot, "packages/examples/jsonrpc-demo/lib"), { recursive: true });
  await mkdir(join(sourceRoot, "examples/jsonrpc-agent"), { recursive: true });
  await mkdir(fakeBin);
  await writeFile(
    join(sourceRoot, "package.json"),
    JSON.stringify({ type: "module", version: overrides.version ?? "0.1.1-rc.2" }),
  );
  await writeFile(join(sourceRoot, "packages/examples/jsonrpc-demo/lib/bin.js"), "");
  await writeFile(join(sourceRoot, "examples/jsonrpc-agent/minimal.cordis.yml"), "[]\n");
  const git = join(fakeBin, "git");
  await writeFile(
    git,
    `#!/bin/sh
if [ -n "\${GIT_DIR:-}" ] || [ -n "\${GIT_WORK_TREE:-}" ] || [ -n "\${GIT_CONFIG_COUNT:-}" ] || [ -n "\${GIT_CONFIG_KEY_0:-}" ]; then exit 91; fi
if [ "$1" = "-C" ]; then shift 2; fi
if [ "$1" = "diff" ]; then
  if [ "$2" = "--cached" ]; then exit "${overrides.indexDirty ?? "0"}"; fi
  exit "${overrides.trackedDirty ?? "0"}"
fi
if [ "$1" = "check-ignore" ]; then exit "${overrides.configIgnored ?? "0"}"; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then printf '%s\\n' "${overrides.head ?? EXPECTED_DSH_REVISION}"; exit 0; fi
if [ "$1" = "rev-parse" ]; then printf '%s\\n' "${overrides.tag ?? EXPECTED_DSH_REVISION}"; exit 0; fi
exit 2
`,
  );
  await chmod(git, 0o755);
  return {
    sourceRoot,
    runtimeRoot,
    parentEnv: {
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      DEEPSEEK_API_KEY: "test-only-key",
      DEEPSEEK_BASE_URL: "https://example.invalid/v1",
      HTTPS_PROXY: "http://proxy.invalid",
      AWS_SECRET_ACCESS_KEY: "not-for-child",
      UNRELATED_SECRET: "not-for-child",
      DSH_CORDIS_CONFIG: "/must/not/leak",
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("resolveRuntimeLaunch", () => {
  test("rejects a relative source path before creating runtime state", async () => {
    const { parentEnv, runtimeRoot } = await fixture();
    await expect(
      resolveRuntimeLaunch({ exampleName: "one", parentEnv, runtimeRoot, sourceRoot: "relative" }),
    ).rejects.toThrow(/absolute/);
  });

  test.each([
    ["tracked worktree", { trackedDirty: "1" }, /tracked worktree/i],
    ["staged index", { indexDirty: "1" }, /staged index/i],
    ["HEAD revision", { head: "deadbeef" }, /HEAD/],
    ["tag revision", { tag: "deadbeef" }, /tag/],
    ["root version", { version: "0.0.0" }, /version/],
  ])("rejects the wrong %s", async (_name, overrides, message) => {
    const value = await fixture(overrides);
    await expect(resolveRuntimeLaunch({ exampleName: "one", ...value })).rejects.toThrow(message);
  });

  test("rejects missing built runtime artifacts", async () => {
    const value = await fixture();
    await rm(join(value.sourceRoot, "packages/examples/jsonrpc-demo/lib/bin.js"));
    await expect(resolveRuntimeLaunch({ exampleName: "one", ...value })).rejects.toThrow(
      /built runtime/,
    );
  });

  test("ignores unrelated untracked files because only both tracked diffs gate launch", async () => {
    const value = await fixture();
    await writeFile(join(value.sourceRoot, "untracked.txt"), "allowed");
    const launch = await resolveRuntimeLaunch({ exampleName: "untracked", ...value });
    expect(launch.source.revision).toBe(EXPECTED_DSH_REVISION);
    await cleanupRuntimeState(launch.state);
  });

  test("scrubs ambient repository and Git config selectors before every explicit source check", async () => {
    const value = await fixture();
    Object.assign(value.parentEnv, {
      GIT_DIR: "/poison/git-dir",
      GIT_WORK_TREE: "/poison/work-tree",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/poison/hooks",
    });
    const launch = await resolveRuntimeLaunch({ exampleName: "scrubbed-git", ...value });
    await cleanupRuntimeState(launch.state);
  });

  test("creates a fresh unique state tree and a replacement child environment", async () => {
    const value = await fixture();
    const first = await resolveRuntimeLaunch({ exampleName: "env", ...value });
    const second = await resolveRuntimeLaunch({ exampleName: "env", ...value });
    expect(first.state.root).not.toBe(second.state.root);
    expect(first.options.command).toBe(process.execPath);
    expect(first.options.args).toEqual([first.source.binPath, first.source.configPath]);
    expect(first.options.cwd).toBe(first.state.workspace);
    expect(first.options.env).toMatchObject({
      DEEPSEEK_API_KEY: "test-only-key",
      DEEPSEEK_BASE_URL: "https://example.invalid/v1",
      HOME: first.state.home,
      DSH_HOME: first.state.dshHome,
      DSH_CWD: first.state.workspace,
      DSH_SESSION_ROOT: first.state.sessions,
      DSH_MODEL: "deepseek-v4-flash",
      DSH_CONTEXT_WINDOW: "1000000",
    });
    for (const forbidden of [
      "DSH_CORDIS_CONFIG",
      "HTTPS_PROXY",
      "AWS_SECRET_ACCESS_KEY",
      "UNRELATED_SECRET",
    ]) {
      expect(first.options.env).not.toHaveProperty(forbidden);
    }
    await expect(readFile(join(first.state.workspace, ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await cleanupRuntimeState(first.state);
    await cleanupRuntimeState(second.state);
  });

  test("requires a nonempty key and omits an empty optional base URL", async () => {
    const missing = await fixture();
    delete missing.parentEnv.DEEPSEEK_API_KEY;
    await expect(resolveRuntimeLaunch({ exampleName: "missing-key", ...missing })).rejects.toThrow(
      /DEEPSEEK_API_KEY/,
    );
    expect(await readdir(missing.runtimeRoot)).toEqual([]);

    const emptyBase = await fixture();
    emptyBase.parentEnv.DEEPSEEK_BASE_URL = "  ";
    const launch = await resolveRuntimeLaunch({ exampleName: "empty-base", ...emptyBase });
    expect(launch.options.env).not.toHaveProperty("DEEPSEEK_BASE_URL");
    await cleanupRuntimeState(launch.state);
  });

  test("refuses to clean an unmarked sibling even when it is below the runtime root", async () => {
    const value = await fixture();
    const launch = await resolveRuntimeLaunch({ exampleName: "owned", ...value });
    const unowned = join(value.runtimeRoot, "unowned-sibling");
    await mkdir(unowned);
    await expect(
      cleanupRuntimeState({
        ...launch.state,
        root: unowned,
        workspace: join(unowned, "workspace"),
      }),
    ).rejects.toThrow(/ownership marker/);
    expect(await readdir(value.runtimeRoot)).toContain("unowned-sibling");
    await cleanupRuntimeState(launch.state);
  });

  test("refuses cleanup when the ownership token does not match", async () => {
    const value = await fixture();
    const launch = await resolveRuntimeLaunch({ exampleName: "token", ...value });
    await expect(
      cleanupRuntimeState({ ...launch.state, ownershipToken: "wrong-token" }),
    ).rejects.toThrow(/mismatched ownership marker/);
    expect(await readdir(value.runtimeRoot)).toContain(launch.state.root.split("/").at(-1));
    await cleanupRuntimeState(launch.state);
  });

  test("refuses a symlink-shaped cleanup target even with a matching marker", async () => {
    const value = await fixture();
    const launch = await resolveRuntimeLaunch({ exampleName: "symlink", ...value });
    const outside = join(value.runtimeRoot, "outside-target");
    const link = join(value.runtimeRoot, "linked-state");
    await mkdir(outside);
    await writeFile(
      join(outside, ".hands-on-dsh-runtime-state"),
      `${launch.state.ownershipToken}\n`,
    );
    await symlink(outside, link, "dir");
    await expect(cleanupRuntimeState({ ...launch.state, root: link })).rejects.toThrow(
      /symbolic link/,
    );
    expect(await readdir(outside)).toContain(".hands-on-dsh-runtime-state");
    await cleanupRuntimeState(launch.state);
  });

  test("accepts only an absolute gitignored config override inside upstream tmp", async () => {
    const value = await fixture();
    const configRoot = join(value.sourceRoot, "tmp", "stage4-real-test");
    const configPath = join(configRoot, "cordis.yml");
    await mkdir(configRoot, { recursive: true });
    await writeFile(configPath, "[]\n");
    const launch = await resolveRuntimeLaunch({
      exampleName: "override",
      configPath,
      ...value,
    });
    const canonicalConfig = await import("node:fs/promises").then(({ realpath }) =>
      realpath(configPath),
    );
    expect(launch.source.configPath).toBe(canonicalConfig);
    expect(launch.options.args).toEqual([launch.source.binPath, canonicalConfig]);
    await cleanupRuntimeState(launch.state);

    await expect(
      resolveRuntimeLaunch({
        exampleName: "relative-override",
        configPath: "relative.yml",
        ...value,
      }),
    ).rejects.toThrow(/config override.*absolute/);
    const outside = join(value.runtimeRoot, "outside.yml");
    await writeFile(outside, "[]\n");
    await expect(
      resolveRuntimeLaunch({
        exampleName: "outside-override",
        configPath: outside,
        ...value,
      }),
    ).rejects.toThrow(/upstream tmp/);
  });

  test("rejects a config override that Git does not classify as ignored", async () => {
    const value = await fixture({ configIgnored: "1" });
    const configRoot = join(value.sourceRoot, "tmp", "stage4-real-unignored");
    const configPath = join(configRoot, "cordis.yml");
    await mkdir(configRoot, { recursive: true });
    await writeFile(configPath, "[]\n");
    await expect(
      resolveRuntimeLaunch({
        exampleName: "unignored-override",
        configPath,
        ...value,
      }),
    ).rejects.toThrow(/gitignored/);
  });
});
