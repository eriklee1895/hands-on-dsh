import { mkdtemp, mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { cleanupRuntimeState, resolveRuntimeLaunch } from "../src/runtime-launch.ts";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-ts-launch-"));
  roots.push(root);
  return {
    runtimeRoot: join(root, "runtime"),
    parentEnv: {
      PATH: process.env.PATH,
      DEEPSEEK_API_KEY: "test-only-key",
      DEEPSEEK_BASE_URL: "https://example.invalid/v1",
      DSH_SOURCE_ROOT: "/no-source-checkout-needed",
      DSH_CORDIS_CONFIG: "/must-not-leak",
      HTTPS_PROXY: "http://proxy.invalid",
      AWS_SECRET_ACCESS_KEY: "not-for-child",
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("published profile launch", () => {
  test("uses the public profile, same-version resolver, and isolated state without source checkout", async () => {
    const options = await fixture();
    const first = await resolveRuntimeLaunch({ exampleName: "published", ...options });
    const second = await resolveRuntimeLaunch({ exampleName: "published", ...options });
    expect(first.state.root).not.toBe(second.state.root);
    expect(first.options).toMatchObject({
      profile: "sdk-minimal",
      dshHome: first.state.dshHome,
      processCwd: first.state.workspace,
      initializeTimeoutMs: 120_000,
    });
    expect(first.options).not.toHaveProperty("dshBin");
    expect(first.options).not.toHaveProperty("command");
    expect(first.options.env).toMatchObject({
      PATH: process.env.PATH,
      DEEPSEEK_API_KEY: "test-only-key",
      DEEPSEEK_BASE_URL: "https://example.invalid/v1",
      HOME: first.state.home,
    });
    for (const forbidden of [
      "DSH_SOURCE_ROOT",
      "DSH_CORDIS_CONFIG",
      "HTTPS_PROXY",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(first.options.env).not.toHaveProperty(forbidden);
    }
    await expect(readFile(join(first.state.workspace, ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await cleanupRuntimeState(first.state);
    await cleanupRuntimeState(second.state);
  });

  test("passes explicit public patch and fake CLI override", async () => {
    const options = await fixture();
    const patch = join(options.runtimeRoot, "profile.patch.yml");
    const dshBin = join(options.runtimeRoot, "fake-dsh.mjs");
    const launch = await resolveRuntimeLaunch({
      exampleName: "override",
      patches: [patch],
      dshBin,
      ...options,
    });
    expect(launch.options.patches).toEqual([patch]);
    expect(launch.options.dshBin).toBe(dshBin);
    await cleanupRuntimeState(launch.state);
  });

  test("rejects missing credentials and relative patches without retaining state", async () => {
    const missing = await fixture();
    delete (missing.parentEnv as Partial<typeof missing.parentEnv>).DEEPSEEK_API_KEY;
    await expect(resolveRuntimeLaunch({ exampleName: "missing", ...missing })).rejects.toThrow(
      /DEEPSEEK_API_KEY/,
    );
    expect(await readdir(missing.runtimeRoot)).toEqual([]);
    const relative = await fixture();
    await expect(
      resolveRuntimeLaunch({ exampleName: "patch", patches: ["relative.yml"], ...relative }),
    ).rejects.toThrow(/absolute/);
    expect(await readdir(relative.runtimeRoot)).toEqual([]);
  });

  test("guards ownership marker, token, and symlink before cleanup", async () => {
    const options = await fixture();
    const launch = await resolveRuntimeLaunch({ exampleName: "owned", ...options });
    const unowned = join(options.runtimeRoot, "unowned");
    await mkdir(unowned);
    await expect(cleanupRuntimeState({ ...launch.state, root: unowned })).rejects.toThrow(
      /ownership marker/,
    );
    await expect(cleanupRuntimeState({ ...launch.state, ownershipToken: "wrong" })).rejects.toThrow(
      /mismatched/,
    );
    const link = join(options.runtimeRoot, "link");
    await symlink(launch.state.root, link, "dir");
    await expect(cleanupRuntimeState({ ...launch.state, root: link })).rejects.toThrow(
      /symbolic link/,
    );
    expect(await readdir(launch.state.root)).toContain(".hands-on-dsh-runtime-state");
    await cleanupRuntimeState(launch.state);
  });
});
