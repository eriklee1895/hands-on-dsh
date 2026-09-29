import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PackageRuntimeManager } from "../src/server/package-runtime.ts";
import type { RuntimeRunInput } from "../src/server/runtime.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agui-package-runtime-"));
  roots.push(root);
  const pluginRoot = join(root, "plugin");
  await mkdir(join(pluginRoot, "dist", "plugins"), { recursive: true });
  await writeFile(
    join(pluginRoot, "package.json"),
    '{"name":"@hands-on-dsh/cordis-plugin-lifecycle","version":"0.1.0"}\n',
  );
  await writeFile(join(pluginRoot, "dist", "plugins", "tool.js"), "export {}\n");
  await writeFile(join(pluginRoot, "dist", "plugins", "listener.js"), "export {}\n");
  const adapterPath = join(root, "adapter.mjs");
  await writeFile(adapterPath, "export {}\n");
  return {
    root,
    appStateRoot: join(root, "state"),
    generationParent: join(root, "generations"),
    testOnlyPluginRoot: pluginRoot,
    testOnlyAdapterPath: adapterPath,
  };
}

test("uses public sdk-minimal launch and retains home across generation restart", async () => {
  const paths = await fixture();
  const launches: Array<{
    profile?: string;
    dshHome?: string;
    patches?: string[];
    processCwd?: string;
    env?: NodeJS.ProcessEnv;
  }> = [];
  const manager = await PackageRuntimeManager.create({
    ...paths,
    parentEnv: { PATH: process.env.PATH, DEEPSEEK_API_KEY: "test-key", RANDOM_SECRET: "omit" },
    testOnlyHarnessFactory: (options) => {
      launches.push(options);
      return {
        async start() {
          const evidencePath = options.env?.STAGE5_VISIBLE_TOOLS_PATH;
          if (!evidencePath) throw new Error("visible-tools evidence path missing");
          await writeFile(evidencePath, '["write_stage4_proof"]\n');
        },
        async run(
          _prompt: string,
          _options: { sessionId: string; onNotification: RuntimeRunInput["onNotification"] },
        ) {
          return { finalResponse: "done" };
        },
        async close() {},
      };
    },
  });
  const firstGeneration = manager.generationRoot;
  const home = manager.dshHome;
  const applicationPatch = await readFile(join(firstGeneration, "application.patch.yml"), "utf8");
  expect(applicationPatch).toContain("includeRuntimeContext: false");
  expect(applicationPatch).toContain("includeHarnessIdentity: false");
  expect(applicationPatch).toContain("id: stage5-sdk-server");
  const result = await manager.run({ sessionId: "same", prompt: "one", onNotification() {} });
  expect(result.finalResponse).toBe("done");
  expect(launches[0]).toMatchObject({
    profile: "sdk-minimal",
    dshHome: home,
    processCwd: manager.workspaceRoot,
  });
  expect(launches[0]?.patches).toHaveLength(2);
  expect(launches[0]?.env?.RANDOM_SECRET).toBeUndefined();
  await mkdir(join(home, "sessions"), { recursive: true });
  await writeFile(join(home, "sessions", "nonce.txt"), "only durable home\n");
  await manager.restart();
  expect(manager.generationRoot).not.toBe(firstGeneration);
  expect(await readFile(join(home, "sessions", "nonce.txt"), "utf8")).toBe("only durable home\n");
  await manager.run({ sessionId: "same", prompt: "two", onNotification() {} });
  expect(launches[1]?.dshHome).toBe(home);
  await manager.close();
  expect(await readdir(paths.generationParent)).toEqual([]);
});

test("failed owner close quarantines generation and prevents replacement launch", async () => {
  const paths = await fixture();
  let launches = 0;
  const manager = await PackageRuntimeManager.create({
    ...paths,
    testOnlyHarnessFactory: (options) => {
      launches += 1;
      return {
        async start() {
          await writeFile(options.env!.STAGE5_VISIBLE_TOOLS_PATH!, '["write_stage4_proof"]\n');
        },
        async run() {
          return { finalResponse: "done" };
        },
        async close() {
          throw new Error("owner not reaped");
        },
      };
    },
  });
  await manager.run({ sessionId: "same", prompt: "one", onNotification() {} });
  await expect(manager.restart()).rejects.toThrow(/owner not reaped/);
  expect(launches).toBe(1);
  await expect(
    manager.run({ sessionId: "same", prompt: "two", onNotification() {} }),
  ).rejects.toThrow(/cleanup|owner|restart/i);
});

test("rejects adapter and plugin drift before preparing a new generation", async () => {
  const paths = await fixture();
  const manager = await PackageRuntimeManager.create({
    ...paths,
    testOnlyHarnessFactory: () => ({
      async start() {},
      async run() {
        return { finalResponse: "unused" };
      },
      async close() {},
    }),
  });
  await writeFile(paths.testOnlyAdapterPath, "export const changed = true\n");
  await expect(manager.restart()).rejects.toThrow(/adapter drift/);
  await writeFile(paths.testOnlyAdapterPath, "export {}\n");
  await writeFile(
    join(paths.testOnlyPluginRoot, "dist/plugins/tool.js"),
    "export const changed = true\n",
  );
  await expect(manager.restart()).rejects.toThrow(/plugin drift/);
  await writeFile(join(paths.testOnlyPluginRoot, "dist/plugins/tool.js"), "export {}\n");
  await manager.restart();
  await manager.close();
});

test("requires exact tool visibility and reaps a failed startup owner", async () => {
  const paths = await fixture();
  let closeCalls = 0;
  const manager = await PackageRuntimeManager.create({
    ...paths,
    testOnlyHarnessFactory: (options) => ({
      async start() {
        await writeFile(options.env!.STAGE5_VISIBLE_TOOLS_PATH!, '["bash","write_stage4_proof"]\n');
      },
      async run() {
        return { finalResponse: "unused" };
      },
      async close() {
        closeCalls += 1;
      },
    }),
  });
  await expect(
    manager.run({ sessionId: "bad", prompt: "prompt", onNotification() {} }),
  ).rejects.toThrow(/visible tools/);
  expect(closeCalls).toBe(1);
  await manager.close();
});

test("persistent-state cleanup requires a closed owner and the original marker", async () => {
  const paths = await fixture();
  const manager = await PackageRuntimeManager.create({
    ...paths,
    testOnlyHarnessFactory: () => ({
      async start() {},
      async run() {
        return { finalResponse: "unused" };
      },
      async close() {},
    }),
  });
  await expect(manager.cleanupPersistentState()).rejects.toThrow(/close/);
  await manager.close();
  const marker = join(manager.stateRoot, ".hands-on-dsh-app-state");
  await writeFile(marker, "other-owner\n");
  await expect(manager.cleanupPersistentState()).rejects.toThrow(/marker mismatch/);
  await writeFile(marker, `${manager.auditOwnerToken}\n`);
  await manager.cleanupPersistentState();
  await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("resolves the installed published CLI, Stage 4 exports, and built resume adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "agui-installed-package-"));
  roots.push(root);
  const manager = await PackageRuntimeManager.create({
    appStateRoot: join(root, "state"),
    generationParent: join(root, "generations"),
    testOnlyHarnessFactory: () => ({
      async start() {},
      async run() {
        return { finalResponse: "unused" };
      },
      async close() {},
    }),
  });
  expect(manager.dshHome).toContain(join(root, "state"));
  await manager.close();
  await manager.cleanupPersistentState();
});

test("shutdown wins a pending startup, prevents prompt, and reaps the late owner", async () => {
  const paths = await fixture();
  let started = 0;
  let closed = 0;
  let prompts = 0;
  const manager = await PackageRuntimeManager.create({
    ...paths,
    testOnlyHarnessFactory: (options) => ({
      async start() {
        started += 1;
        await writeFile(options.env!.STAGE5_VISIBLE_TOOLS_PATH!, '["write_stage4_proof"]\n');
      },
      async run() {
        prompts += 1;
        return { finalResponse: "must not run" };
      },
      async close() {
        closed += 1;
      },
    }),
  });
  const running = manager.run({ sessionId: "race", prompt: "no prompt", onNotification() {} });
  const outcome = running.catch((error: unknown) => error);
  await manager.shutdown();
  const failure = await outcome;
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/shutdown|closed|uncertain/i);
  expect(started).toBe(1);
  expect(prompts).toBe(0);
  expect(closed).toBe(1);
  expect(await readdir(paths.generationParent)).toEqual([]);
});

test("failed shutdown reaping quarantines the owner and keeps its generation", async () => {
  const paths = await fixture();
  let closeAttempts = 0;
  const manager = await PackageRuntimeManager.create({
    ...paths,
    testOnlyHarnessFactory: (options) => ({
      async start() {
        await writeFile(options.env!.STAGE5_VISIBLE_TOOLS_PATH!, '["write_stage4_proof"]\n');
      },
      async run() {
        return { finalResponse: "done" };
      },
      async close() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("owner still alive");
      },
    }),
  });
  await manager.run({ sessionId: "race", prompt: "first", onNotification() {} });
  const generation = manager.generationRoot;
  await expect(manager.shutdown()).rejects.toThrow(/owner still alive/);
  expect(await readdir(paths.generationParent)).toHaveLength(1);
  expect(manager.generationRoot).toBe(generation);
  await expect(
    manager.run({ sessionId: "race", prompt: "late", onNotification() {} }),
  ).rejects.toThrow(/shutdown|cleanup|owner/i);
  await manager.shutdown();
  expect(closeAttempts).toBe(2);
  expect(await readdir(paths.generationParent)).toEqual([]);
});

test("restart blocks new runs and coalesces overlapping generation changes", async () => {
  const paths = await fixture();
  let launches = 0;
  let releaseClose: (() => void) | undefined;
  let closeEntered: (() => void) | undefined;
  const closeStarted = new Promise<void>((resolve) => {
    closeEntered = resolve;
  });
  const holdClose = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const manager = await PackageRuntimeManager.create({
    ...paths,
    testOnlyHarnessFactory: (options) => {
      launches += 1;
      const number = launches;
      return {
        async start() {
          await writeFile(options.env!.STAGE5_VISIBLE_TOOLS_PATH!, '["write_stage4_proof"]\n');
        },
        async run() {
          return { finalResponse: `generation-${number}` };
        },
        async close() {
          if (number === 1) {
            closeEntered?.();
            await holdClose;
          }
        },
      };
    },
  });
  await manager.run({ sessionId: "one", prompt: "first", onNotification() {} });
  const firstRestart = manager.restart();
  await closeStarted;
  const secondRestart = manager.restart();
  await expect(
    manager.run({ sessionId: "two", prompt: "late", onNotification() {} }),
  ).rejects.toThrow(/restart|transition/);
  releaseClose?.();
  await Promise.all([firstRestart, secondRestart]);
  expect(manager.generation).toBe(2);
  expect(
    (await manager.run({ sessionId: "three", prompt: "new", onNotification() {} })).finalResponse,
  ).toBe("generation-2");
  expect(launches).toBe(2);
  await manager.close();
});
