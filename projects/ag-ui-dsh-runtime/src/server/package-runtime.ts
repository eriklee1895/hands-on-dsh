import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeepSeekHarness,
  type DeepSeekHarnessOptions,
  type HarnessNotification,
  type RunResult,
} from "@deepseek-ai/dsh-sdk-client";
import {
  RuntimeTransportUncertainError,
  type DshRuntimePort,
  type RuntimeRunInput,
  type RuntimeRunResult,
} from "./runtime.js";

const EXPECTED_VERSION = "0.1.7-rc.2";
const PACKAGE_NAME = "@hands-on-dsh/cordis-plugin-lifecycle";

interface HarnessLike {
  start(): Promise<void>;
  run(
    prompt: string,
    options: { sessionId: string; onNotification(notification: HarnessNotification): void },
  ): Promise<Pick<RunResult, "finalResponse">>;
  close(): Promise<void>;
}

export type HarnessFactory = (options: DeepSeekHarnessOptions) => HarnessLike;

export interface PackageRuntimeManagerOptions {
  appStateRoot?: string;
  generationParent?: string;
  parentEnv?: NodeJS.ProcessEnv;
  /** A local built fixture is accepted only with a test harness factory. */
  testOnlyPluginRoot?: string;
  /** A local compiled adapter is accepted only with a test harness factory. */
  testOnlyAdapterPath?: string;
  testOnlyHarnessFactory?: HarnessFactory;
}

interface PluginEvidence {
  root: string;
  toolPath: string;
  listenerPath: string;
  dependencyPlane: string;
  revalidate(): Promise<void>;
}

interface AdapterEvidence {
  path: string;
  hash: string;
  revalidate(): Promise<void>;
}

async function projectRoot(start: string): Promise<string> {
  let current = resolve(start);
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(join(current, "package.json"), "utf8")) as {
        name?: unknown;
      };
      if (manifest.name === "hands-on-dsh-ag-ui-runtime") return current;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("could not locate AG-UI project root");
    current = parent;
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function regularFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} must remain a regular non-symlink file`);
}

async function versionedDshBin(): Promise<string> {
  const dshManifestPath = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh/package.json"));
  const clientManifestPath = fileURLToPath(
    import.meta.resolve("@deepseek-ai/dsh-sdk-client/package.json"),
  );
  const dsh = JSON.parse(await readFile(dshManifestPath, "utf8")) as {
    version?: unknown;
    bin?: { dsh?: unknown };
  };
  const client = JSON.parse(await readFile(clientManifestPath, "utf8")) as { version?: unknown };
  if (dsh.version !== EXPECTED_VERSION || client.version !== EXPECTED_VERSION)
    throw new Error("the published dsh CLI and SDK client must both be 0.1.7-rc.2");
  if (typeof dsh.bin?.dsh !== "string") throw new Error("published dsh CLI has no executable");
  const path = resolve(dirname(dshManifestPath), dsh.bin.dsh);
  await regularFile(path, "published dsh CLI");
  return path;
}

async function pluginEvidence(rootValue: string, dependencyPlane: string): Promise<PluginEvidence> {
  const root = await realpath(rootValue);
  const toolPath = join(root, "dist/plugins/tool.js");
  const listenerPath = join(root, "dist/plugins/listener.js");
  const manifestPath = join(root, "package.json");
  for (const path of [toolPath, listenerPath, manifestPath])
    await regularFile(path, "Stage 4 plugin");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    exports?: Record<string, { default?: unknown }>;
  };
  if (manifest.name !== PACKAGE_NAME || manifest.version !== "0.1.0")
    throw new Error("Stage 4 plugin identity does not match");
  // Export fields are verified for the installed package; tests may use a minimal fixture.
  const hashes = await Promise.all([
    hashFile(toolPath),
    hashFile(listenerPath),
    hashFile(manifestPath),
  ]);
  return {
    root,
    toolPath,
    listenerPath,
    dependencyPlane,
    async revalidate() {
      const paths = [toolPath, listenerPath, manifestPath];
      for (const path of paths) await regularFile(path, "Stage 4 plugin");
      const current = await Promise.all(paths.map(hashFile));
      if (current.some((hash, index) => hash !== hashes[index]))
        throw new Error("Stage 4 plugin drift detected");
    },
  };
}

async function installedPluginEvidence(): Promise<PluginEvidence> {
  const toolPath = await realpath(
    fileURLToPath(import.meta.resolve("@hands-on-dsh/cordis-plugin-lifecycle/tool")),
  );
  const listenerPath = await realpath(
    fileURLToPath(import.meta.resolve("@hands-on-dsh/cordis-plugin-lifecycle/listener")),
  );
  const root = resolve(dirname(toolPath), "../..");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    exports?: Record<string, { default?: unknown }>;
  };
  if (
    manifest.exports?.["./tool"]?.default !== "./dist/plugins/tool.js" ||
    manifest.exports?.["./listener"]?.default !== "./dist/plugins/listener.js" ||
    toolPath !== (await realpath(join(root, "dist/plugins/tool.js"))) ||
    listenerPath !== (await realpath(join(root, "dist/plugins/listener.js")))
  )
    throw new Error("installed Stage 4 plugin exports do not match");
  return pluginEvidence(root, resolve(root, "../.."));
}

async function adapterEvidence(pathValue: string): Promise<AdapterEvidence> {
  const unresolved = resolve(pathValue);
  await regularFile(unresolved, "SDK resume adapter");
  const path = await realpath(unresolved);
  const hash = await hashFile(path);
  return {
    path,
    hash,
    async revalidate() {
      await regularFile(path, "SDK resume adapter");
      if ((await hashFile(path)) !== hash) throw new Error("SDK resume adapter drift detected");
    },
  };
}

async function installedAdapterEvidence(): Promise<AdapterEvidence> {
  const candidates = [
    join(import.meta.dirname, "sdk-resume-adapter.js"),
    resolve(import.meta.dirname, "../../dist/server/server/sdk-resume-adapter.js"),
  ];
  for (const candidate of candidates) {
    try {
      return await adapterEvidence(candidate);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  throw new Error("built SDK resume adapter is missing; run build:server first");
}

function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function applicationPatch(input: { adapterPath: string; sessionRoot: string }): string {
  return `- id: sdk-jsonrpc-server
  disabled: true
- insert:
    - id: stage5-sdk-server
      name: ${yamlString(input.adapterPath)}
      inject: [sdkAppStartup, loader]
      config:
        maxTokensAsSuccess: false
- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    personaPrefix: 'For every user message, call write_stage4_proof exactly once. Pass the complete user message verbatim as content, then reply briefly. Do not call any other tool.'
- id: persistent-bash
  disabled: true
- id: persistent-pwsh
  disabled: true
- id: sessions
  config:
    root: ${yamlString(input.sessionRoot)}
    compression: none
`;
}

function pluginPatch(input: {
  toolPath: string;
  listenerPath: string;
  visiblePath: string;
  auditPath: string;
  healthPath: string;
  ownerToken: string;
  workspaceRoot: string;
  evidencePath: string;
}): string {
  return `- insert:
    - id: stage4-proof-tool
      name: ${yamlString(input.toolPath)}
      config:
        workspaceRoot: ${yamlString(input.workspaceRoot)}
        partitionMode: 'call'
    - id: stage4-proof-listener
      name: ${yamlString(input.listenerPath)}
      config:
        sessionMode: 'all'
        toolName: 'write_stage4_proof'
        auditPath: ${yamlString(input.auditPath)}
        healthPath: ${yamlString(input.healthPath)}
        auditOwnerToken: ${yamlString(input.ownerToken)}
    - id: visible-tools
      name: ${yamlString(input.visiblePath)}
      config:
        evidencePath: ${yamlString(input.evidencePath)}
`;
}

const visibleToolsPlugin = `import { writeFileSync } from 'node:fs'
export const name = 'stage5-visible-tools-proof'
export const inject = ['tools']
export async function apply(ctx, config) {
  const deadline = Date.now() + 2000
  while (true) {
    const names = ctx.tools.schemas().map(tool => tool.name).sort()
    if (names.includes('write_stage4_proof')) {
      if (JSON.stringify(names) !== JSON.stringify(['write_stage4_proof'])) throw new Error('unexpected visible tools')
      writeFileSync(config.evidencePath, JSON.stringify(names) + '\\n', { flag: 'wx' })
      return
    }
    if (Date.now() >= deadline) throw new Error('tool visibility timeout')
    await new Promise(resolve => setImmediate(resolve))
  }
}
`;

export class PackageRuntimeManager implements DshRuntimePort {
  generation = 1;
  activeRuns = 0;
  readonly workspaceRoot: string;
  readonly sessionRoot: string;
  readonly dshHome: string;
  readonly stateRoot: string;
  readonly auditOwnerToken: string;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly harnessFactory: HarnessFactory;
  private readonly generationParent: string;
  private readonly projectModules: string;
  private readonly plugin: PluginEvidence;
  private readonly adapter: AdapterEvidence;
  private generationRootValue: string | undefined;
  private patchPaths: string[] = [];
  private generationAdapterPath: string | undefined;
  private harness: HarnessLike | undefined;
  private attemptedHarness: HarnessLike | undefined;
  private startupPromise: Promise<HarnessLike> | undefined;
  private startupFatal: Error | undefined;
  private closed = false;
  private lost = false;
  private shutdownRequested = false;
  private transition: "idle" | "restarting" | "shutting-down" = "idle";
  private restartPromise: Promise<void> | undefined;
  private shutdownPromise: Promise<void> | undefined;

  private constructor(input: {
    parentEnv: NodeJS.ProcessEnv;
    harnessFactory: HarnessFactory;
    stateRoot: string;
    workspaceRoot: string;
    sessionRoot: string;
    dshHome: string;
    auditOwnerToken: string;
    generationParent: string;
    projectModules: string;
    plugin: PluginEvidence;
    adapter: AdapterEvidence;
  }) {
    this.parentEnv = input.parentEnv;
    this.harnessFactory = input.harnessFactory;
    this.stateRoot = input.stateRoot;
    this.workspaceRoot = input.workspaceRoot;
    this.sessionRoot = input.sessionRoot;
    this.dshHome = input.dshHome;
    this.auditOwnerToken = input.auditOwnerToken;
    this.generationParent = input.generationParent;
    this.projectModules = input.projectModules;
    this.plugin = input.plugin;
    this.adapter = input.adapter;
  }

  get generationRoot(): string {
    if (this.generationRootValue === undefined)
      throw new Error("runtime generation is not prepared");
    return this.generationRootValue;
  }

  static async create(options: PackageRuntimeManagerOptions = {}): Promise<PackageRuntimeManager> {
    if (
      (options.testOnlyPluginRoot !== undefined || options.testOnlyAdapterPath !== undefined) &&
      options.testOnlyHarnessFactory === undefined
    )
      throw new Error("local plugin and adapter fixtures require a test harness factory");
    await versionedDshBin();
    const root = await projectRoot(import.meta.dirname);
    const stateRoot = resolve(options.appStateRoot ?? join(root, ".runtime", "app-state"));
    const generationParent = resolve(
      options.generationParent ?? join(root, ".runtime", "generations"),
    );
    await mkdir(dirname(stateRoot), { recursive: true, mode: 0o700 });
    await mkdir(generationParent, { recursive: true, mode: 0o700 });
    const generationMetadata = await lstat(generationParent);
    if (!generationMetadata.isDirectory() || generationMetadata.isSymbolicLink())
      throw new Error("runtime generation parent must be a real directory");
    const markerPath = join(stateRoot, ".hands-on-dsh-app-state");
    let stateCreated = false;
    let auditOwnerToken: string;
    try {
      try {
        const metadata = await lstat(stateRoot);
        if (
          !metadata.isDirectory() ||
          metadata.isSymbolicLink() ||
          (metadata.mode & 0o777) !== 0o700
        )
          throw new Error("app state root must be a real 0700 directory");
        await regularFile(markerPath, "app state ownership marker");
        const marker = await lstat(markerPath);
        if ((marker.mode & 0o777) !== 0o600) throw new Error("app state marker must be 0600");
        auditOwnerToken = (await readFile(markerPath, "utf8")).trim();
        if (auditOwnerToken === "") throw new Error("app state ownership marker is empty");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await mkdir(stateRoot, { mode: 0o700 });
        stateCreated = true;
        auditOwnerToken = randomUUID();
        await writeFile(markerPath, `${auditOwnerToken}\n`, { flag: "wx", mode: 0o600 });
      }
      const workspaceRoot = join(stateRoot, "workspace");
      const dshHome = join(stateRoot, "dsh-home");
      const sessionRoot = join(dshHome, "sessions");
      const evidenceRoot = join(stateRoot, "evidence");
      for (const path of [workspaceRoot, dshHome, sessionRoot, evidenceRoot]) {
        await mkdir(path, { recursive: true, mode: 0o700 });
        const metadata = await lstat(path);
        if (
          !metadata.isDirectory() ||
          metadata.isSymbolicLink() ||
          (metadata.mode & 0o777) !== 0o700
        )
          throw new Error("app state directories must be real 0700 directories");
      }
      const plugin =
        options.testOnlyPluginRoot === undefined
          ? await installedPluginEvidence()
          : await pluginEvidence(options.testOnlyPluginRoot, join(root, "node_modules"));
      const adapter =
        options.testOnlyAdapterPath === undefined
          ? await installedAdapterEvidence()
          : await adapterEvidence(options.testOnlyAdapterPath);
      const manager = new PackageRuntimeManager({
        parentEnv: options.parentEnv ?? process.env,
        harnessFactory: options.testOnlyHarnessFactory ?? ((launch) => new DeepSeekHarness(launch)),
        stateRoot,
        workspaceRoot: await realpath(workspaceRoot),
        sessionRoot: await realpath(sessionRoot),
        dshHome: await realpath(dshHome),
        auditOwnerToken,
        generationParent,
        projectModules: join(root, "node_modules"),
        plugin,
        adapter,
      });
      await manager.prepareGeneration(1);
      return manager;
    } catch (error) {
      if (stateCreated) {
        try {
          await rm(stateRoot, { recursive: true, force: true });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "runtime initialization rollback failed");
        }
      }
      throw error;
    }
  }

  private async prepareGeneration(generation: number): Promise<void> {
    await versionedDshBin();
    await this.plugin.revalidate();
    await this.adapter.revalidate();
    const generationRoot = await mkdtemp(join(this.generationParent, `ag-ui-dsh-g${generation}-`));
    try {
      const pluginTarget = join(generationRoot, "plugin");
      await cp(join(this.plugin.root, "dist"), join(pluginTarget, "dist"), { recursive: true });
      await cp(join(this.plugin.root, "package.json"), join(pluginTarget, "package.json"));
      await symlink(this.plugin.dependencyPlane, join(pluginTarget, "node_modules"), "dir");
      const adapterTarget = join(generationRoot, "sdk-resume-adapter.mjs");
      await cp(this.adapter.path, adapterTarget);
      await regularFile(adapterTarget, "copied SDK resume adapter");
      if ((await hashFile(adapterTarget)) !== this.adapter.hash)
        throw new Error("copied SDK resume adapter hash drift detected");
      await symlink(this.projectModules, join(generationRoot, "node_modules"), "dir");
      const visiblePath = join(generationRoot, "visible-tools.mjs");
      await writeFile(visiblePath, visibleToolsPlugin, { flag: "wx", mode: 0o600 });
      const applicationPath = join(generationRoot, "application.patch.yml");
      const pluginPath = join(generationRoot, "plugins.patch.yml");
      await writeFile(
        applicationPath,
        applicationPatch({ adapterPath: adapterTarget, sessionRoot: this.sessionRoot }),
        { flag: "wx", mode: 0o600 },
      );
      await writeFile(
        pluginPath,
        pluginPatch({
          toolPath: join(pluginTarget, "dist/plugins/tool.js"),
          listenerPath: join(pluginTarget, "dist/plugins/listener.js"),
          visiblePath,
          auditPath: join(this.stateRoot, "evidence/tool-audit.jsonl"),
          healthPath: join(this.stateRoot, "evidence/tool-health.jsonl"),
          ownerToken: this.auditOwnerToken,
          workspaceRoot: this.workspaceRoot,
          evidencePath: join(generationRoot, "visible-tools.json"),
        }),
        { flag: "wx", mode: 0o600 },
      );
      this.generationRootValue = generationRoot;
      this.patchPaths = [applicationPath, pluginPath];
      this.generationAdapterPath = adapterTarget;
    } catch (error) {
      try {
        await rm(generationRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "runtime generation rollback failed");
      }
      throw error;
    }
  }

  private childEnvironment(generationRoot: string, visibleToolsPath: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const name of [
      "PATH",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
    ] as const) {
      const value = this.parentEnv[name];
      if (value !== undefined && value !== "") env[name] = value;
    }
    for (const name of ["DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"] as const) {
      const value = this.parentEnv[name]?.trim();
      if (value !== undefined && value !== "") env[name] = value;
    }
    Object.assign(env, {
      HOME: join(generationRoot, "home"),
      STAGE5_VISIBLE_TOOLS_PATH: visibleToolsPath,
    });
    return env;
  }

  private async startHarness(): Promise<HarnessLike> {
    await versionedDshBin();
    await this.plugin.revalidate();
    await this.adapter.revalidate();
    const adapterPath = this.generationAdapterPath;
    if (adapterPath === undefined) throw new Error("copied SDK resume adapter is missing");
    await regularFile(adapterPath, "copied SDK resume adapter");
    if ((await hashFile(adapterPath)) !== this.adapter.hash)
      throw new Error("copied SDK resume adapter hash drift detected");
    const generationRoot = this.generationRoot;
    await mkdir(join(generationRoot, "home"), { mode: 0o700 });
    const visibleToolsPath = join(generationRoot, "visible-tools.json");
    const harness = this.harnessFactory({
      profile: "sdk-minimal",
      patches: [...this.patchPaths],
      dshHome: this.dshHome,
      processCwd: this.workspaceRoot,
      cwd: this.workspaceRoot,
      env: this.childEnvironment(generationRoot, visibleToolsPath),
      shutdownTimeoutMs: 1_000,
      disposeEofGraceMs: 6_000,
      disposeGraceMs: 3_000,
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
    });
    this.attemptedHarness = harness;
    try {
      await harness.start();
      const deadline = Date.now() + 2_000;
      for (;;) {
        try {
          const visible = JSON.parse(await readFile(visibleToolsPath, "utf8")) as unknown;
          if (JSON.stringify(visible) !== JSON.stringify(["write_stage4_proof"]))
            throw new Error("runtime visible tools are not exactly write_stage4_proof");
          break;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          if (Date.now() >= deadline) throw new Error("runtime visible-tools probe timed out");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    } catch (error) {
      const failures: unknown[] = [error];
      let closeSucceeded = false;
      try {
        await harness.close();
        closeSucceeded = true;
      } catch (closeError) {
        failures.push(closeError);
      }
      if (closeSucceeded) {
        this.attemptedHarness = undefined;
        for (const path of [join(generationRoot, "home"), visibleToolsPath]) {
          try {
            await rm(path, { recursive: true, force: true });
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
      }
      if (failures.length > 1) {
        const fatal = new AggregateError(failures, "runtime start cleanup failed");
        const surfaced = closeSucceeded
          ? fatal
          : new RuntimeTransportUncertainError(
              "runtime startup failed and the attempted process could not be closed",
              { cause: fatal },
            );
        this.startupFatal = surfaced;
        this.lost = true;
        throw surfaced;
      }
      throw error;
    }
    this.harness = harness;
    this.attemptedHarness = undefined;
    return harness;
  }

  private async ensureHarness(): Promise<HarnessLike> {
    if (this.closed) throw new Error("runtime manager is closed");
    if (this.shutdownRequested)
      throw new RuntimeTransportUncertainError("runtime shutdown before prompt");
    if (this.transition !== "idle") throw new Error("runtime transition is in progress");
    if (this.startupFatal instanceof RuntimeTransportUncertainError) throw this.startupFatal;
    if (this.startupFatal !== undefined)
      throw new Error(
        `runtime start cleanup failed; explicit restart or close is required: ${this.startupFatal.message}`,
      );
    if (this.lost)
      throw new RuntimeTransportUncertainError("runtime must be restarted after transport loss");
    if (this.generationRootValue === undefined)
      throw new Error("runtime generation must be prepared by restart after setup failure");
    if (this.harness !== undefined) return this.harness;
    if (this.startupPromise !== undefined) {
      const existing = await this.startupPromise;
      if (this.shutdownRequested)
        throw new RuntimeTransportUncertainError("runtime shutdown before prompt");
      return existing;
    }
    const startup = this.startHarness();
    this.startupPromise = startup;
    try {
      const ready = await startup;
      if (this.shutdownRequested)
        throw new RuntimeTransportUncertainError("runtime shutdown before prompt");
      return ready;
    } finally {
      if (this.startupPromise === startup) this.startupPromise = undefined;
    }
  }

  async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
    if (this.closed || this.shutdownRequested)
      throw new RuntimeTransportUncertainError("runtime shutdown before prompt");
    if (this.transition !== "idle") throw new Error("runtime restart is in progress");
    this.activeRuns += 1;
    try {
      const harness = await this.ensureHarness();
      const result = await harness.run(input.prompt, {
        sessionId: input.sessionId,
        onNotification: input.onNotification,
      });
      return { finalResponse: result.finalResponse };
    } catch (error) {
      if (
        error instanceof RuntimeTransportUncertainError ||
        (error instanceof Error && error.name === "TransportClosedError")
      ) {
        this.lost = true;
        throw error instanceof RuntimeTransportUncertainError
          ? error
          : new RuntimeTransportUncertainError(error.message);
      }
      throw error;
    } finally {
      this.activeRuns -= 1;
    }
  }

  async restart(): Promise<void> {
    if (this.closed) throw new Error("runtime manager is closed");
    if (this.shutdownRequested) throw new Error("runtime shutdown is in progress");
    if (this.restartPromise !== undefined) return this.restartPromise;
    if (this.activeRuns !== 0) throw new Error("runtime has active runs");
    this.transition = "restarting";
    const operation = this.restartOwned();
    this.restartPromise = operation;
    try {
      await operation;
      if (!this.shutdownRequested) this.transition = "idle";
    } finally {
      if (this.restartPromise === operation) this.restartPromise = undefined;
    }
  }

  private async restartOwned(): Promise<void> {
    if (this.generationRootValue === undefined) {
      if (this.shutdownRequested) throw new Error("runtime shutdown interrupted restart");
      await this.prepareGeneration(this.generation);
      this.lost = false;
      return;
    }
    const old = this.harness ?? this.attemptedHarness;
    if (old !== undefined) await this.closeOwner(old);
    this.harness = undefined;
    this.attemptedHarness = undefined;
    this.startupFatal = undefined;
    const oldGenerationRoot = this.generationRoot;
    await rm(oldGenerationRoot, { recursive: true, force: true });
    this.generationRootValue = undefined;
    this.patchPaths = [];
    this.generationAdapterPath = undefined;
    this.generation += 1;
    if (this.shutdownRequested) throw new Error("runtime shutdown interrupted restart");
    await this.prepareGeneration(this.generation);
    this.lost = false;
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true;
    this.transition = "shutting-down";
    if (this.closed) return;
    if (this.shutdownPromise !== undefined) return this.shutdownPromise;
    const operation = this.shutdownOwned();
    this.shutdownPromise = operation;
    try {
      await operation;
    } finally {
      if (this.shutdownPromise === operation) this.shutdownPromise = undefined;
    }
  }

  private async shutdownOwned(): Promise<void> {
    if (this.restartPromise !== undefined) {
      try {
        await this.restartPromise;
      } catch {
        /* Shutdown owns the remaining cleanup. */
      }
    }
    if (this.startupPromise !== undefined) {
      try {
        await this.startupPromise;
      } catch {
        /* Shutdown owns the attempted owner. */
      }
    }
    const harness = this.harness ?? this.attemptedHarness;
    if (harness !== undefined) await this.closeOwner(harness);
    if (this.generationRootValue !== undefined)
      await rm(this.generationRootValue, { recursive: true, force: true });
    this.generationRootValue = undefined;
    this.patchPaths = [];
    this.generationAdapterPath = undefined;
    this.harness = undefined;
    this.attemptedHarness = undefined;
    this.startupFatal = undefined;
    this.closed = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.activeRuns !== 0) throw new Error("runtime has active runs");
    await this.shutdown();
  }

  private async closeOwner(owner: HarnessLike): Promise<void> {
    try {
      await owner.close();
    } catch (error) {
      this.startupFatal = new RuntimeTransportUncertainError(
        "runtime owner cleanup failed; replacement generation is forbidden",
        { cause: error },
      );
      this.lost = true;
      throw error;
    }
  }

  async cleanupPersistentState(): Promise<void> {
    if (!this.closed) throw new Error("close the runtime manager before persistent cleanup");
    const metadata = await lstat(this.stateRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("refusing persistent cleanup through a non-directory");
    const marker = await readFile(join(this.stateRoot, ".hands-on-dsh-app-state"), "utf8");
    if (marker !== `${this.auditOwnerToken}\n`)
      throw new Error("app state ownership marker mismatch");
    await rm(this.stateRoot, { recursive: true, force: true });
  }
}
