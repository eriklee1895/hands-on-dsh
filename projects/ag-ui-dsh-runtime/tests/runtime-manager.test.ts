import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, test } from "vitest";
import {
  SourceRuntimeManager,
  type HarnessFactory,
  type SourceEvidence,
} from "../src/server/source-runtime.ts";
import { RuntimeTransportUncertainError } from "../src/server/runtime.ts";

const roots: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "agui-source-manager-"));
  roots.push(root);
  const source = join(root, "source");
  const appStateRoot = join(root, "project/.runtime/app-state");
  const generationParent = join(root, "generations");
  const pluginRoot = join(root, "plugin");
  const adapterPath = join(root, "sdk-resume-adapter.js");
  await mkdir(join(source, "packages/examples/jsonrpc-demo/lib"), { recursive: true });
  await mkdir(join(source, "node_modules/.pnpm/node_modules"), { recursive: true });
  await mkdir(join(pluginRoot, "dist/plugins"), { recursive: true });
  await writeFile(join(source, "packages/examples/jsonrpc-demo/lib/bin.js"), "// built\n");
  await writeFile(join(pluginRoot, "dist/plugins/tool.js"), "export const name='tool'\n");
  await writeFile(join(pluginRoot, "dist/plugins/listener.js"), "export const name='listener'\n");
  await writeFile(adapterPath, "export const name='fixture-resume-adapter'\n");
  await writeFile(
    join(pluginRoot, "package.json"),
    JSON.stringify({ name: "fixture", type: "module" }),
  );
  const evidence: SourceEvidence = {
    root: source,
    revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    binPath: join(source, "packages/examples/jsonrpc-demo/lib/bin.js"),
    hostNodeModules: join(source, "node_modules/.pnpm/node_modules"),
    async revalidate() {},
    testOnlyAllowPluginRoot: true,
    testOnlyAdapterPath: adapterPath,
  };
  return { root, source, appStateRoot, generationParent, pluginRoot, adapterPath, evidence };
}

describe("source-backed runtime manager", () => {
  test("rejects pluginRoot without explicit test bypass and injected source evidence", async () => {
    const fixture = await sourceFixture();
    await expect(
      SourceRuntimeManager.create({
        sourceRoot: fixture.source,
        appStateRoot: fixture.appStateRoot,
        generationParent: fixture.generationParent,
        pluginRoot: fixture.pluginRoot,
        allowExternalGenerationParentForTests: true,
        testOnlySourceProbe: async () => ({ ...fixture.evidence, testOnlyAllowPluginRoot: false }),
      }),
    ).rejects.toThrow(/pluginRoot is available only/);
  });

  test("resolves the tracked Stage 4 package when pluginRoot is omitted", async () => {
    const fixture = await sourceFixture();
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: (options) => ({
        async start() {
          await writeFile(
            options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
            '["write_stage4_proof"]\n',
          );
        },
        async run() {
          return { finalResponse: "" };
        },
        async close() {},
      }),
    });
    expect(await readFile(manager.configPath, "utf8")).toContain("stage4-proof-tool");
    await manager.close();
  });

  test("copies and hash-verifies the project SDK resume adapter in generated config", async () => {
    const fixture = await sourceFixture();
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
    });
    const copiedAdapter = join(manager.generationRoot, "sdk-resume-adapter.mjs");
    const config = await readFile(manager.configPath, "utf8");

    expect(await readFile(copiedAdapter, "utf8")).toContain("fixture-resume-adapter");
    expect(config).toContain(`name: '${copiedAdapter}'`);
    expect(config).not.toContain(`name: '@deepseek-ai/dsh-sdk-jsonrpc-server'`);

    await writeFile(fixture.adapterPath, "// adapter drift\n");
    await expect(manager.restart()).rejects.toThrow(/adapter.*drift/i);
    await manager.close();
  });

  test("rejects a copied SDK resume adapter hash drift before starting a Harness", async () => {
    const fixture = await sourceFixture();
    let factories = 0;
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: () => {
        factories += 1;
        return {
          async start() {},
          async run() {
            return { finalResponse: "" };
          },
          async close() {},
        };
      },
    });
    await writeFile(join(manager.generationRoot, "sdk-resume-adapter.mjs"), "// copied drift\n");

    await expect(manager.run({ sessionId: "s", prompt: "p", onNotification() {} })).rejects.toThrow(
      /copied.*adapter.*drift/i,
    );
    expect(factories).toBe(0);
    await manager.close();
  });

  test("rejects a same-byte source adapter symlink before preparing a restart generation", async () => {
    const fixture = await sourceFixture();
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
    });
    const bytes = await readFile(fixture.adapterPath);
    const replacement = join(fixture.root, "same-byte-source-adapter.js");
    await writeFile(replacement, bytes);
    await rm(fixture.adapterPath);
    await symlink(replacement, fixture.adapterPath);

    await expect(manager.restart()).rejects.toThrow(/adapter.*regular|adapter.*symlink/i);
    await manager.close();
  });

  test("rejects a same-byte copied adapter symlink before starting a Harness", async () => {
    const fixture = await sourceFixture();
    let factories = 0;
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: () => {
        factories += 1;
        return {
          async start() {},
          async run() {
            return { finalResponse: "" };
          },
          async close() {},
        };
      },
    });
    const copied = join(manager.generationRoot, "sdk-resume-adapter.mjs");
    const bytes = await readFile(copied);
    const replacement = join(fixture.root, "same-byte-copied-adapter.mjs");
    await writeFile(replacement, bytes);
    await rm(copied);
    await symlink(replacement, copied);

    await expect(manager.run({ sessionId: "s", prompt: "p", onNotification() {} })).rejects.toThrow(
      /copied.*adapter.*regular|copied.*adapter.*symlink/i,
    );
    expect(factories).toBe(0);
    await manager.close();
  });

  test("rebuilds a terminal Harness while retaining canonical workspace/session state", async () => {
    const fixture = await sourceFixture();
    const launches: Array<{ env: NodeJS.ProcessEnv; closed: boolean }> = [];
    const factory: HarnessFactory = (options) => {
      const launch = { env: options.launch.env!, closed: false };
      launches.push(launch);
      return {
        async start() {
          await writeFile(launch.env.STAGE5_VISIBLE_TOOLS_PATH!, '["write_stage4_proof"]\n', {
            flag: "wx",
          });
        },
        async run(prompt, runOptions) {
          const memoryPath = join(launch.env.DSH_SESSION_ROOT!, `${runOptions.sessionId}.txt`);
          let previous = "";
          try {
            previous = await readFile(memoryPath, "utf8");
          } catch {}
          await writeFile(memoryPath, `${previous}${prompt}\n`);
          return { finalResponse: previous };
        },
        async close() {
          launch.closed = true;
        },
      };
    };
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      parentEnv: { PATH: process.env.PATH, RANDOM_SECRET: "must-not-leak" },
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: factory,
    });
    const persistentWorkspace = manager.workspaceRoot;
    const persistentSessions = manager.sessionRoot;

    await manager.run({ sessionId: "stable", prompt: "first", onNotification() {} });
    await manager.restart();
    const second = await manager.run({
      sessionId: "stable",
      prompt: "second",
      onNotification() {},
    });

    expect(second.finalResponse).toBe("first\n");
    expect(manager.generation).toBe(2);
    expect(launches).toHaveLength(2);
    expect(launches[0]?.closed).toBe(true);
    expect(launches[0]?.env.DSH_CWD).toBe(persistentWorkspace);
    expect(launches[1]?.env.DSH_CWD).toBe(persistentWorkspace);
    expect(launches[0]?.env.DSH_SESSION_ROOT).toBe(persistentSessions);
    expect(launches[1]?.env.DSH_SESSION_ROOT).toBe(persistentSessions);
    expect(launches[0]?.env.HOME).not.toBe(launches[1]?.env.HOME);
    expect(launches[0]?.env.RANDOM_SECRET).toBeUndefined();
    const config = await readFile(manager.configPath, "utf8");
    expect(config).toContain("partitionMode: 'call'");
    expect(config).toContain("sessionMode: 'all'");
    expect(config).toContain("write_stage4_proof");
    expect(config).toContain("For every user message, call write_stage4_proof exactly once");
    expect(config).not.toMatch(/persistent-bash|str-replace-editor/);
    const ownedRoot = manager.stateRoot;
    await manager.close();
    await manager.close();
    await expect(access(ownedRoot)).resolves.toBeUndefined();
    const reopened = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: factory,
    });
    expect(reopened.auditOwnerToken).toBe(manager.auditOwnerToken);
    const third = await reopened.run({ sessionId: "stable", prompt: "third", onNotification() {} });
    expect(third.finalResponse).toBe("first\nsecond\n");
    await reopened.close();
    await reopened.cleanupPersistentState();
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses restart while active and maps a closed transport to uncertainty", async () => {
    const fixture = await sourceFixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const factory: HarnessFactory = (options) => ({
      async start() {
        await writeFile(
          options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
          '["write_stage4_proof"]\n',
          { flag: "wx" },
        );
      },
      async run() {
        await blocked;
        const error = new Error("runtime pipe closed");
        error.name = "TransportClosedError";
        throw error;
      },
      async close() {},
    });
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: factory,
    });
    const run = manager.run({ sessionId: "stable", prompt: "uncertain", onNotification() {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(manager.restart()).rejects.toThrow(/active runs/);
    release();
    await expect(run).rejects.toBeInstanceOf(RuntimeTransportUncertainError);
    await manager.close();
  });

  test("fails startup immediately when the visible tool set is not exact", async () => {
    const fixture = await sourceFixture();
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: (options) => ({
        async start() {
          await writeFile(
            options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
            '["extra","write_stage4_proof"]\n',
          );
        },
        async run() {
          return { finalResponse: "" };
        },
        async close() {},
      }),
    });
    await expect(manager.run({ sessionId: "s", prompt: "p", onNotification() {} })).rejects.toThrow(
      /not exactly/,
    );
    await manager.close();
  });

  test("singleflights concurrent startup and retries a cleaned failed handshake", async () => {
    const fixture = await sourceFixture();
    let factories = 0;
    let starts = 0;
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: (options) => {
        factories += 1;
        return {
          async start() {
            starts += 1;
            await writeFile(
              options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
              '["write_stage4_proof"]\n',
              { flag: "wx" },
            );
            if (starts === 1) throw new Error("handshake failed");
          },
          async run(prompt) {
            return { finalResponse: prompt };
          },
          async close() {},
        };
      },
    });
    await expect(
      manager.run({ sessionId: "s", prompt: "first", onNotification() {} }),
    ).rejects.toThrow(/handshake failed/);
    const results = await Promise.all([
      manager.run({ sessionId: "s1", prompt: "one", onNotification() {} }),
      manager.run({ sessionId: "s2", prompt: "two", onNotification() {} }),
    ]);
    expect(results.map((result) => result.finalResponse)).toEqual(["one", "two"]);
    expect(factories).toBe(2);
    expect(starts).toBe(2);
    await manager.close();
  });

  test("retains a failed-start Harness when cleanup close fails and forbids a second process", async () => {
    const fixture = await sourceFixture();
    let factories = 0;
    let allowClose = false;
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: (options) => {
        factories += 1;
        const index = factories;
        return {
          async start() {
            await writeFile(
              options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
              '["write_stage4_proof"]\n',
            );
            if (index === 1) throw new Error("handshake failed");
          },
          async run() {
            return { finalResponse: "recovered" };
          },
          async close() {
            if (index === 1 && !allowClose) throw new Error("attempted process still alive");
          },
        };
      },
    });
    const first = manager.run({ sessionId: "s", prompt: "first", onNotification() {} });
    await expect(first).rejects.toBeInstanceOf(RuntimeTransportUncertainError);
    await expect(first).rejects.toMatchObject({ cause: expect.any(AggregateError) });
    await expect(
      manager.run({ sessionId: "s", prompt: "second", onNotification() {} }),
    ).rejects.toThrow(/attempted process could not be closed/);
    expect(factories).toBe(1);
    allowClose = true;
    await manager.restart();
    await expect(
      manager.run({ sessionId: "s", prompt: "third", onNotification() {} }),
    ).resolves.toMatchObject({ finalResponse: "recovered" });
    expect(factories).toBe(2);
    await manager.close();
  });

  test("keeps the current generation when terminal harness close fails during restart", async () => {
    const fixture = await sourceFixture();
    let failClose = true;
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: (options) => ({
        async start() {
          await writeFile(
            options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
            '["write_stage4_proof"]\n',
          );
        },
        async run() {
          return { finalResponse: "" };
        },
        async close() {
          if (failClose) throw new Error("close failed");
        },
      }),
    });
    await manager.run({ sessionId: "s", prompt: "p", onNotification() {} });
    const config = manager.configPath;
    await expect(manager.restart()).rejects.toThrow(/close failed/);
    expect(manager.generation).toBe(1);
    expect(manager.configPath).toBe(config);
    failClose = false;
    await manager.close();
  });

  test("can retry the same new generation after composition preparation fails", async () => {
    const fixture = await sourceFixture();
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: (options) => ({
        async start() {
          await writeFile(
            options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
            '["write_stage4_proof"]\n',
          );
        },
        async run() {
          return { finalResponse: "ready" };
        },
        async close() {},
      }),
    });
    await manager.run({ sessionId: "s", prompt: "first", onNotification() {} });
    await rm(join(fixture.pluginRoot, "dist"), { recursive: true });
    await expect(manager.restart()).rejects.toThrow();
    expect(manager.generation).toBe(2);
    await mkdir(join(fixture.pluginRoot, "dist/plugins"), { recursive: true });
    await writeFile(join(fixture.pluginRoot, "dist/plugins/tool.js"), "export const name='tool'\n");
    await writeFile(
      join(fixture.pluginRoot, "dist/plugins/listener.js"),
      "export const name='listener'\n",
    );
    await manager.restart();
    expect(manager.generation).toBe(2);
    await expect(
      manager.run({ sessionId: "s", prompt: "second", onNotification() {} }),
    ).resolves.toMatchObject({ finalResponse: "ready" });
    await manager.close();
  });

  test("revalidates source attestation and plugin hashes before restart generation", async () => {
    const fixture = await sourceFixture();
    let sourceChecks = 0;
    let sourceDrift = false;
    const evidence: SourceEvidence = {
      ...fixture.evidence,
      async revalidate() {
        sourceChecks += 1;
        if (sourceDrift) throw new Error("runtime build attestation drift detected");
      },
    };
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => evidence,
      testOnlyHarnessFactory: (options) => ({
        async start() {
          await writeFile(
            options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
            '["write_stage4_proof"]\n',
          );
        },
        async run() {
          return { finalResponse: "" };
        },
        async close() {},
      }),
    });
    expect(sourceChecks).toBe(1);
    sourceDrift = true;
    await expect(manager.restart()).rejects.toThrow(/attestation drift/);
    expect(sourceChecks).toBe(2);
    sourceDrift = false;
    await manager.restart();
    expect(sourceChecks).toBe(3);
    await manager.close();
  });

  test("revalidates provenance after create and before the first Harness process", async () => {
    const fixture = await sourceFixture();
    let checks = 0;
    let drift = false;
    let factories = 0;
    const evidence: SourceEvidence = {
      ...fixture.evidence,
      async revalidate() {
        checks += 1;
        if (drift) throw new Error("post-create attestation drift");
      },
    };
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => evidence,
      testOnlyHarnessFactory: () => {
        factories += 1;
        return {
          async start() {},
          async run() {
            return { finalResponse: "" };
          },
          async close() {},
        };
      },
    });
    expect(checks).toBe(1);
    drift = true;
    await expect(manager.run({ sessionId: "s", prompt: "p", onNotification() {} })).rejects.toThrow(
      /post-create attestation drift/,
    );
    expect(checks).toBe(2);
    expect(factories).toBe(0);
    await manager.close();
  });

  test("rejects Stage 4 plugin drift before a restart generation is prepared", async () => {
    const fixture = await sourceFixture();
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: () => ({
        async start() {},
        async run() {
          return { finalResponse: "" };
        },
        async close() {},
      }),
    });
    await writeFile(join(fixture.pluginRoot, "dist/plugins/tool.js"), "// plugin drift\n");
    await expect(manager.restart()).rejects.toThrow(/plugin attestation drift/);
    await manager.close();
  });

  test.each(["dirty", "head"] as const)(
    "rejects scrubbed Git %s drift on restart",
    async (kind) => {
      const fixture = await sourceFixture();
      await execFileAsync("git", ["init", fixture.source]);
      await execFileAsync("git", ["-C", fixture.source, "add", "."]);
      await execFileAsync("git", [
        "-C",
        fixture.source,
        "-c",
        "user.name=Attestation Test",
        "-c",
        "user.email=attestation@example.invalid",
        "commit",
        "-m",
        "initial",
      ]);
      const expectedHead = (
        await execFileAsync("git", ["-C", fixture.source, "rev-parse", "HEAD"], {
          encoding: "utf8",
        })
      ).stdout.trim();
      const gitEnv: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      };
      const evidence: SourceEvidence = {
        ...fixture.evidence,
        async revalidate() {
          try {
            await execFileAsync("git", ["-C", fixture.source, "diff", "--quiet"], { env: gitEnv });
            await execFileAsync("git", ["-C", fixture.source, "diff", "--cached", "--quiet"], {
              env: gitEnv,
            });
          } catch (error) {
            throw new Error("source dirty drift", { cause: error });
          }
          const head = (
            await execFileAsync("git", ["-C", fixture.source, "rev-parse", "HEAD"], {
              env: gitEnv,
              encoding: "utf8",
            })
          ).stdout.trim();
          if (head !== expectedHead) throw new Error("source HEAD drift");
        },
      };
      const manager = await SourceRuntimeManager.create({
        sourceRoot: fixture.source,
        appStateRoot: fixture.appStateRoot,
        generationParent: fixture.generationParent,
        pluginRoot: fixture.pluginRoot,
        allowExternalGenerationParentForTests: true,
        testOnlySourceProbe: async () => evidence,
        testOnlyHarnessFactory: () => ({
          async start() {},
          async run() {
            return { finalResponse: "" };
          },
          async close() {},
        }),
      });
      if (kind === "dirty") {
        await writeFile(evidence.binPath, "// dirty drift\n");
      } else {
        await writeFile(join(fixture.source, "head-drift.txt"), "drift\n");
        await execFileAsync("git", ["-C", fixture.source, "add", "head-drift.txt"]);
        await execFileAsync("git", [
          "-C",
          fixture.source,
          "-c",
          "user.name=Attestation Test",
          "-c",
          "user.email=attestation@example.invalid",
          "commit",
          "-m",
          "head drift",
        ]);
      }
      await expect(manager.restart()).rejects.toThrow(
        kind === "dirty" ? /dirty drift/ : /HEAD drift/,
      );
      await manager.close();
    },
  );

  test("forced shutdown closes the whole Harness and settles an active run", async () => {
    const fixture = await sourceFixture();
    let rejectRun: ((error: Error) => void) | undefined;
    const manager = await SourceRuntimeManager.create({
      sourceRoot: fixture.source,
      appStateRoot: fixture.appStateRoot,
      generationParent: fixture.generationParent,
      pluginRoot: fixture.pluginRoot,
      allowExternalGenerationParentForTests: true,
      testOnlySourceProbe: async () => fixture.evidence,
      testOnlyHarnessFactory: (options) => ({
        async start() {
          await writeFile(
            options.launch.env!.STAGE5_VISIBLE_TOOLS_PATH!,
            '["write_stage4_proof"]\n',
          );
        },
        async run() {
          return new Promise((_resolve, reject) => {
            rejectRun = reject;
          });
        },
        async close() {
          const error = new Error("transport closed by owner");
          error.name = "TransportClosedError";
          rejectRun?.(error);
        },
      }),
    });
    const run = manager.run({ sessionId: "s", prompt: "active", onNotification() {} });
    while (rejectRun === undefined) await new Promise((resolve) => setImmediate(resolve));
    const shutdown = manager.shutdown();
    await expect(run).rejects.toBeInstanceOf(RuntimeTransportUncertainError);
    await shutdown;
    expect(manager.activeRuns).toBe(0);
    await manager.cleanupPersistentState();
  });
});
