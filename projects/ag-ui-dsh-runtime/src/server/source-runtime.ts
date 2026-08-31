import { execFile } from "node:child_process";
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
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
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
import { validateRuntimeBuildAttestation } from "./runtime-attestation.js";
import { RUNTIME_BARE_PLUGINS } from "./runtime-composition.js";

const execFileAsync = promisify(execFile);
const EXPECTED_REVISION = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
const EXPECTED_TAG = "dsh-v0.1.1-rc.2";
const EXPECTED_VERSION = "0.1.1-rc.2";

export interface SourceEvidence {
  root: string;
  revision: string;
  binPath: string;
  hostNodeModules: string;
  revalidate(): Promise<void>;
  testOnlyAllowPluginRoot?: boolean;
  /** Explicit compiled adapter fixture supplied only by an injected source probe. */
  testOnlyAdapterPath?: string;
}

interface HarnessLike {
  start(): Promise<void>;
  run(
    prompt: string,
    options: { sessionId: string; onNotification(notification: HarnessNotification): void },
  ): Promise<Pick<RunResult, "finalResponse">>;
  close(): Promise<void>;
}

export type HarnessFactory = (options: DeepSeekHarnessOptions) => HarnessLike;

export interface SourceRuntimeManagerOptions {
  sourceRoot: string;
  appStateRoot?: string;
  generationParent?: string;
  pluginRoot?: string;
  parentEnv?: NodeJS.ProcessEnv;
  /** Trusted same-process test seam; production callers must omit it. */
  testOnlySourceProbe?: (
    sourceRoot: string,
    parentEnv: NodeJS.ProcessEnv,
  ) => Promise<SourceEvidence>;
  /** Trusted same-process test seam; production callers must omit it. */
  testOnlyHarnessFactory?: HarnessFactory;
  allowExternalGenerationParentForTests?: boolean;
  allowTestPluginRootForTests?: boolean;
}

interface PluginEvidence {
  root: string;
  toolPath: string;
  listenerPath: string;
  revalidate(): Promise<void>;
}

interface DeploymentAdapterEvidence {
  path: string;
  hash: string;
  revalidate(): Promise<void>;
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function validateAdapterFile(
  path: string,
  expectedHash: string,
  label: string,
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} must remain a regular non-symlink file`);
  if ((await hashFile(path)) !== expectedHash) throw new Error(`${label} hash drift detected`);
}

async function deploymentAdapterEvidence(pathValue: string): Promise<DeploymentAdapterEvidence> {
  const unresolved = resolve(pathValue);
  const metadata = await lstat(unresolved);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("SDK resume adapter must be a regular compiled file");
  const path = await realpath(unresolved);
  const hash = await hashFile(path);
  await validateAdapterFile(path, hash, "SDK resume adapter");
  return {
    path,
    hash,
    async revalidate() {
      await validateAdapterFile(path, hash, "SDK resume adapter");
    },
  };
}

async function installedDeploymentAdapterEvidence(): Promise<DeploymentAdapterEvidence> {
  const candidates = [
    join(import.meta.dirname, "sdk-resume-adapter.js"),
    resolve(import.meta.dirname, "../../dist/server/server/sdk-resume-adapter.js"),
  ];
  for (const candidate of candidates) {
    try {
      return await deploymentAdapterEvidence(candidate);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  throw new Error("built SDK resume adapter is missing; run the server build first");
}

async function testPluginEvidence(rootValue: string): Promise<PluginEvidence> {
  const root = await realpath(rootValue);
  const toolPath = await realpath(join(root, "dist/plugins/tool.js"));
  const listenerPath = await realpath(join(root, "dist/plugins/listener.js"));
  const manifestPath = await realpath(join(root, "package.json"));
  const expected = {
    tool: await hashFile(toolPath),
    listener: await hashFile(listenerPath),
    manifest: await hashFile(manifestPath),
  };
  return {
    root,
    toolPath,
    listenerPath,
    async revalidate() {
      if (
        (await hashFile(toolPath)) !== expected.tool ||
        (await hashFile(listenerPath)) !== expected.listener ||
        (await hashFile(manifestPath)) !== expected.manifest
      )
        throw new Error("Stage 4 plugin attestation drift detected");
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
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    name?: unknown;
    version?: unknown;
    exports?: Record<string, { default?: unknown }>;
  };
  if (
    manifest.name !== "@hands-on-dsh/cordis-plugin-lifecycle" ||
    manifest.version !== "0.1.0" ||
    manifest.exports?.["./tool"]?.default !== "./dist/plugins/tool.js" ||
    manifest.exports?.["./listener"]?.default !== "./dist/plugins/listener.js"
  )
    throw new Error("installed Stage 4 plugin package metadata/exports do not match");
  if (
    toolPath !== (await realpath(join(root, "dist/plugins/tool.js"))) ||
    listenerPath !== (await realpath(join(root, "dist/plugins/listener.js")))
  )
    throw new Error("installed Stage 4 plugin exports resolve to unexpected files");
  const expected = {
    tool: await hashFile(toolPath),
    listener: await hashFile(listenerPath),
    manifest: await hashFile(manifestPath),
  };
  return {
    root,
    toolPath,
    listenerPath,
    async revalidate() {
      const currentTool = await realpath(
        fileURLToPath(import.meta.resolve("@hands-on-dsh/cordis-plugin-lifecycle/tool")),
      );
      const currentListener = await realpath(
        fileURLToPath(import.meta.resolve("@hands-on-dsh/cordis-plugin-lifecycle/listener")),
      );
      if (
        currentTool !== toolPath ||
        currentListener !== listenerPath ||
        (await hashFile(toolPath)) !== expected.tool ||
        (await hashFile(listenerPath)) !== expected.listener ||
        (await hashFile(manifestPath)) !== expected.manifest
      )
        throw new Error("installed Stage 4 plugin attestation drift detected");
    },
  };
}

function scrubbedGitEnvironment(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const) {
    const value = parentEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}

async function requireFile(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error(`${label} must be a regular file`);
}

async function defaultSourceProbe(
  sourceRoot: string,
  parentEnv: NodeJS.ProcessEnv,
): Promise<SourceEvidence> {
  if (!isAbsolute(sourceRoot)) throw new Error("DSH source root must be absolute");
  const root = await realpath(sourceRoot);
  const gitEnv = scrubbedGitEnvironment(parentEnv);
  const binPath = join(root, "packages/examples/jsonrpc-demo/lib/bin.js");
  const hostNodeModules = join(root, "node_modules/.pnpm/node_modules");
  const revalidate = async () => {
    await execFileAsync("git", ["-C", root, "diff", "--quiet"], { env: gitEnv });
    await execFileAsync("git", ["-C", root, "diff", "--cached", "--quiet"], { env: gitEnv });
    const revision = (
      await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
        env: gitEnv,
        encoding: "utf8",
      })
    ).stdout.trim();
    const tagRevision = (
      await execFileAsync("git", ["-C", root, "rev-parse", `${EXPECTED_TAG}^{commit}`], {
        env: gitEnv,
        encoding: "utf8",
      })
    ).stdout.trim();
    if (revision !== EXPECTED_REVISION || tagRevision !== EXPECTED_REVISION)
      throw new Error(`DSH source must remain ${EXPECTED_TAG} (${EXPECTED_REVISION})`);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    };
    if (manifest.version !== EXPECTED_VERSION)
      throw new Error(`DSH source version must remain ${EXPECTED_VERSION}`);
    await requireFile(binPath, "built DSH JSON-RPC bin");
    const hostMetadata = await lstat(hostNodeModules);
    if (!hostMetadata.isDirectory()) throw new Error("upstream host dependency plane is missing");
    await validateRuntimeBuildAttestation(root, {
      revision: EXPECTED_REVISION,
      version: EXPECTED_VERSION,
    });
  };
  await revalidate();
  return { root, revision: EXPECTED_REVISION, binPath, hostNodeModules, revalidate };
}

function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function configText(input: {
  sdkAdapterPath: string;
  toolPath: string;
  listenerPath: string;
  auditPath: string;
  healthPath: string;
  ownerToken: string;
}): string {
  return `- id: sdk-jsonrpc-server
  name: ${yamlString(input.sdkAdapterPath)}
  config:
    maxTokensAsSuccess: false
- id: llm-deepseek
  name: '${RUNTIME_BARE_PLUGINS.llmDeepSeek}'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    models:
      - id: !!js process.env.DSH_MODEL ?? 'deepseek-v4-flash'
        contextWindow: 1000000
- id: sandbox
  name: '${RUNTIME_BARE_PLUGINS.sandboxLocal}'
- id: sandbox-policy
  name: '${RUNTIME_BARE_PLUGINS.sandboxPolicy}'
  config:
    mode: danger-full-access
    workspaceRoot: !!js process.env.DSH_CWD
- id: subprocess
  name: '${RUNTIME_BARE_PLUGINS.subprocessLocal}'
- id: pty
  name: '${RUNTIME_BARE_PLUGINS.terminal}'
- id: terminal-bash
  name: '${RUNTIME_BARE_PLUGINS.terminalBash}'
- id: fs-local
  name: '${RUNTIME_BARE_PLUGINS.fsLocal}'
  config:
    cwd: !!js process.env.DSH_CWD
- id: agent-spine
  name: '${RUNTIME_BARE_PLUGINS.agentSpine}'
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    persona: 'For every user message, call write_stage4_proof exactly once. Pass the complete user message verbatim as content, then reply briefly. Do not call any other tool.'
    workspaceContext: false
    skills:
      enabled: false
    toolBash: false
    toolJobs: false
- id: sessions
  name: '${RUNTIME_BARE_PLUGINS.sessionPersistence}'
  config:
    root: !!js process.env.DSH_SESSION_ROOT
    compression: none
- id: stage4-proof-tool
  name: ${yamlString(input.toolPath)}
  config:
    workspaceRoot: !!js process.env.DSH_CWD
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
  name: './visible-tools.mjs'
  config:
    evidencePath: !!js process.env.STAGE5_VISIBLE_TOOLS_PATH
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

export class SourceRuntimeManager implements DshRuntimePort {
  generation = 1;
  activeRuns = 0;
  readonly workspaceRoot: string;
  readonly sessionRoot: string;
  readonly stateRoot: string;
  readonly auditOwnerToken: string;
  private readonly source: SourceEvidence;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly harnessFactory: HarnessFactory;
  private readonly generationParent: string;
  private readonly plugin: PluginEvidence;
  private readonly adapter: DeploymentAdapterEvidence;
  private generationRootValue: string | undefined;
  private configPathValue: string | undefined;
  private generationAdapterPathValue: string | undefined;
  private harness: HarnessLike | undefined;
  private attemptedHarness: HarnessLike | undefined;
  private startupPromise: Promise<HarnessLike> | undefined;
  private startupFatal: Error | undefined;
  private closed = false;
  private lost = false;

  private constructor(input: {
    source: SourceEvidence;
    parentEnv: NodeJS.ProcessEnv;
    harnessFactory: HarnessFactory;
    stateRoot: string;
    workspaceRoot: string;
    sessionRoot: string;
    auditOwnerToken: string;
    generationParent: string;
    plugin: PluginEvidence;
    adapter: DeploymentAdapterEvidence;
  }) {
    this.source = input.source;
    this.parentEnv = input.parentEnv;
    this.harnessFactory = input.harnessFactory;
    this.stateRoot = input.stateRoot;
    this.workspaceRoot = input.workspaceRoot;
    this.sessionRoot = input.sessionRoot;
    this.auditOwnerToken = input.auditOwnerToken;
    this.generationParent = input.generationParent;
    this.plugin = input.plugin;
    this.adapter = input.adapter;
  }

  get configPath(): string {
    if (this.configPathValue === undefined) throw new Error("runtime generation is not prepared");
    return this.configPathValue;
  }

  get generationRoot(): string {
    if (this.generationRootValue === undefined)
      throw new Error("runtime generation is not prepared");
    return this.generationRootValue;
  }

  static async create(options: SourceRuntimeManagerOptions): Promise<SourceRuntimeManager> {
    const parentEnv = options.parentEnv ?? process.env;
    const source = await (options.testOnlySourceProbe ?? defaultSourceProbe)(
      options.sourceRoot,
      parentEnv,
    );
    const stateRoot = resolve(
      options.appStateRoot ?? join(import.meta.dirname, "../../.runtime/app-state"),
    );
    const generationParent = resolve(options.generationParent ?? join(source.root, "tmp"));
    const stateParent = dirname(stateRoot);
    await mkdir(stateParent, { recursive: true, mode: 0o700 });
    const stateParentMetadata = await lstat(stateParent);
    if (!stateParentMetadata.isDirectory() || stateParentMetadata.isSymbolicLink())
      throw new Error("app state parent must be a real directory");
    await mkdir(generationParent, { recursive: true, mode: 0o700 });
    const generationParentMetadata = await lstat(generationParent);
    if (!generationParentMetadata.isDirectory() || generationParentMetadata.isSymbolicLink())
      throw new Error("runtime generation parent must be a real directory");
    if (options.allowExternalGenerationParentForTests === true) {
      if (options.testOnlySourceProbe === undefined)
        throw new Error("external generation parent bypass requires an injected source probe");
    } else {
      const sourceTmp = resolve(source.root, "tmp");
      if (generationParent !== sourceTmp && !generationParent.startsWith(`${sourceTmp}${sep}`))
        throw new Error("runtime generation parent must be inside upstream tmp");
      try {
        await execFileAsync(
          "git",
          ["-C", source.root, "check-ignore", "-q", "--", generationParent],
          { env: scrubbedGitEnvironment(parentEnv) },
        );
      } catch {
        throw new Error("runtime generation parent must be gitignored by the DSH checkout");
      }
    }
    const markerPath = join(stateRoot, ".hands-on-dsh-app-state");
    let stateCreated = false;
    let auditOwnerToken: string;
    try {
      try {
        const stateMetadata = await lstat(stateRoot);
        if (
          !stateMetadata.isDirectory() ||
          stateMetadata.isSymbolicLink() ||
          (stateMetadata.mode & 0o777) !== 0o700
        )
          throw new Error("app state root must be a real 0700 directory");
        const markerMetadata = await lstat(markerPath);
        if (
          !markerMetadata.isFile() ||
          markerMetadata.isSymbolicLink() ||
          (markerMetadata.mode & 0o777) !== 0o600
        )
          throw new Error("app state ownership marker must be a regular 0600 file");
        auditOwnerToken = (await readFile(markerPath, "utf8")).trim();
        if (auditOwnerToken === "") throw new Error("app state ownership marker is empty");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        await mkdir(stateRoot, { recursive: false, mode: 0o700 });
        stateCreated = true;
        auditOwnerToken = randomUUID();
        await writeFile(markerPath, `${auditOwnerToken}\n`, { flag: "wx", mode: 0o600 });
      }
      const workspaceRoot = join(stateRoot, "workspace");
      const sessionRoot = join(stateRoot, "sessions");
      const evidenceRoot = join(stateRoot, "evidence");
      for (const path of [workspaceRoot, sessionRoot, evidenceRoot]) {
        if (stateCreated) await mkdir(path, { mode: 0o700 });
        const metadata = await lstat(path);
        if (
          !metadata.isDirectory() ||
          metadata.isSymbolicLink() ||
          (metadata.mode & 0o777) !== 0o700
        )
          throw new Error("app state directories must be real 0700 directories");
      }
      let plugin: PluginEvidence;
      if (options.pluginRoot !== undefined) {
        const testBypass =
          options.allowTestPluginRootForTests === true || source.testOnlyAllowPluginRoot === true;
        if (!testBypass || options.testOnlySourceProbe === undefined)
          throw new Error(
            "pluginRoot is available only with explicit test bypass and source evidence",
          );
        plugin = await testPluginEvidence(options.pluginRoot);
      } else {
        plugin = await installedPluginEvidence();
      }
      const adapter =
        source.testOnlyAdapterPath === undefined
          ? await installedDeploymentAdapterEvidence()
          : await deploymentAdapterEvidence(source.testOnlyAdapterPath);
      if (source.testOnlyAdapterPath !== undefined && options.testOnlySourceProbe === undefined)
        throw new Error("test SDK resume adapter requires an injected source probe");
      const manager = new SourceRuntimeManager({
        source,
        parentEnv,
        harnessFactory: options.testOnlyHarnessFactory ?? ((launch) => new DeepSeekHarness(launch)),
        stateRoot,
        workspaceRoot: await realpath(workspaceRoot),
        sessionRoot: await realpath(sessionRoot),
        auditOwnerToken,
        generationParent,
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
    await this.source.revalidate();
    await this.plugin.revalidate();
    await this.adapter.revalidate();
    const generationRoot = await mkdtemp(join(this.generationParent, `ag-ui-dsh-g${generation}-`));
    try {
      const pluginTarget = join(generationRoot, "plugin");
      await cp(join(this.plugin.root, "dist"), join(pluginTarget, "dist"), { recursive: true });
      await cp(join(this.plugin.root, "package.json"), join(pluginTarget, "package.json"));
      const adapterTarget = join(generationRoot, "sdk-resume-adapter.mjs");
      await cp(this.adapter.path, adapterTarget);
      await validateAdapterFile(adapterTarget, this.adapter.hash, "copied SDK resume adapter");
      await symlink(this.source.hostNodeModules, join(generationRoot, "node_modules"), "dir");
      await writeFile(join(generationRoot, "visible-tools.mjs"), visibleToolsPlugin, {
        flag: "wx",
        mode: 0o600,
      });
      const configPath = join(generationRoot, "cordis.yml");
      await writeFile(
        configPath,
        configText({
          sdkAdapterPath: adapterTarget,
          toolPath: join(pluginTarget, "dist/plugins/tool.js"),
          listenerPath: join(pluginTarget, "dist/plugins/listener.js"),
          auditPath: join(this.stateRoot, "evidence/tool-audit.jsonl"),
          healthPath: join(this.stateRoot, "evidence/tool-health.jsonl"),
          ownerToken: this.auditOwnerToken,
        }),
        { flag: "wx", mode: 0o600 },
      );
      this.generationRootValue = generationRoot;
      this.configPathValue = configPath;
      this.generationAdapterPathValue = adapterTarget;
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
      DSH_HOME: join(generationRoot, "dsh-home"),
      DSH_CWD: this.workspaceRoot,
      DSH_SESSION_ROOT: this.sessionRoot,
      DSH_MODEL: "deepseek-v4-flash",
      STAGE5_VISIBLE_TOOLS_PATH: visibleToolsPath,
    });
    return env;
  }

  private async startHarness(): Promise<HarnessLike> {
    await this.source.revalidate();
    await this.plugin.revalidate();
    await this.adapter.revalidate();
    const generationAdapterPath = this.generationAdapterPathValue;
    if (generationAdapterPath === undefined)
      throw new Error("copied SDK resume adapter path is unavailable");
    await validateAdapterFile(
      generationAdapterPath,
      this.adapter.hash,
      "copied SDK resume adapter",
    );
    const generationRoot = this.generationRoot;
    await mkdir(join(generationRoot, "home"), { recursive: true, mode: 0o700 });
    await mkdir(join(generationRoot, "dsh-home"), { recursive: true, mode: 0o700 });
    const visibleToolsPath = join(generationRoot, "visible-tools.json");
    const harness = this.harnessFactory({
      launch: {
        command: process.execPath,
        args: [this.source.binPath, this.configPath],
        cwd: this.workspaceRoot,
        env: this.childEnvironment(generationRoot, visibleToolsPath),
        shutdownTimeoutMs: 1_000,
        disposeEofGraceMs: 6_000,
        disposeGraceMs: 3_000,
      },
      cwd: this.workspaceRoot,
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
        for (const path of [
          join(generationRoot, "home"),
          join(generationRoot, "dsh-home"),
          visibleToolsPath,
        ]) {
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
    if (this.startupPromise !== undefined) return this.startupPromise;
    const startup = this.startHarness();
    this.startupPromise = startup;
    try {
      return await startup;
    } finally {
      if (this.startupPromise === startup) this.startupPromise = undefined;
    }
  }

  async run(input: RuntimeRunInput): Promise<RuntimeRunResult> {
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
    if (this.activeRuns !== 0) throw new Error("runtime has active runs");
    if (this.closed) throw new Error("runtime manager is closed");
    if (this.generationRootValue === undefined) {
      await this.prepareGeneration(this.generation);
      this.lost = false;
      return;
    }
    const old = this.harness ?? this.attemptedHarness;
    if (old !== undefined) await old.close();
    this.harness = undefined;
    this.attemptedHarness = undefined;
    this.startupFatal = undefined;
    const oldGenerationRoot = this.generationRoot;
    await rm(oldGenerationRoot, { recursive: true, force: true });
    this.generationRootValue = undefined;
    this.configPathValue = undefined;
    this.generationAdapterPathValue = undefined;
    this.generation += 1;
    await this.prepareGeneration(this.generation);
    this.lost = false;
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    const harness = this.harness ?? this.attemptedHarness;
    if (harness !== undefined) await harness.close();
    if (this.startupPromise !== undefined) {
      try {
        await this.startupPromise;
      } catch {
        // The forced close owns this startup failure; process teardown already completed above.
      }
    }
    if (this.generationRootValue !== undefined)
      await rm(this.generationRootValue, { recursive: true, force: true });
    this.generationRootValue = undefined;
    this.configPathValue = undefined;
    this.generationAdapterPathValue = undefined;
    this.harness = undefined;
    this.attemptedHarness = undefined;
    this.startupFatal = undefined;
    this.closed = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.activeRuns !== 0) throw new Error("runtime has active runs");
    const harness = this.harness ?? this.attemptedHarness;
    if (harness !== undefined) await harness.close();
    if (this.generationRootValue !== undefined)
      await rm(this.generationRootValue, { recursive: true, force: true });
    this.generationRootValue = undefined;
    this.configPathValue = undefined;
    this.generationAdapterPathValue = undefined;
    this.harness = undefined;
    this.attemptedHarness = undefined;
    this.startupFatal = undefined;
    this.closed = true;
  }

  async cleanupPersistentState(): Promise<void> {
    if (!this.closed) throw new Error("close the runtime manager before persistent cleanup");
    const metadata = await lstat(this.stateRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("refusing persistent cleanup through a non-directory");
    const markerPath = join(this.stateRoot, ".hands-on-dsh-app-state");
    const marker = await readFile(markerPath, "utf8");
    if (marker !== `${this.auditOwnerToken}\n`)
      throw new Error("app state ownership marker mismatch");
    await rm(this.stateRoot, { recursive: true, force: true });
  }
}
