import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { HarnessClientOptions } from "@deepseek-ai/dsh-sdk-client";

const execFileAsync = promisify(execFile);
const OWNERSHIP_MARKER = ".hands-on-dsh-runtime-state";

export const EXPECTED_DSH_VERSION = "0.1.1-rc.2";
export const EXPECTED_DSH_TAG = "dsh-v0.1.1-rc.2";
export const EXPECTED_DSH_REVISION = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
export const DSH_PROVIDER = "deepseek-official";
export const DSH_MODEL = "deepseek-v4-flash";
export const DSH_CONTEXT_WINDOW = "1000000";
export const DSH_SYSTEM_PROMPT =
  "You are the deterministic runtime used by the hands-on-dsh TypeScript SDK tutorial.";

const CHILD_ENV_ALLOWLIST = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

export interface RuntimeState {
  readonly runtimeRoot: string;
  readonly root: string;
  readonly workspace: string;
  readonly sessions: string;
  readonly home: string;
  readonly dshHome: string;
  readonly ownershipToken: string;
}

export interface SourceEvidence {
  readonly root: string;
  readonly revision: string;
  readonly tag: string;
  readonly version: string;
  readonly binPath: string;
  readonly configPath: string;
}

export interface ResolvedRuntimeLaunch {
  readonly options: HarnessClientOptions;
  readonly state: RuntimeState;
  readonly source: SourceEvidence;
  readonly provider: typeof DSH_PROVIDER;
  readonly model: typeof DSH_MODEL;
}

export interface ResolveRuntimeLaunchOptions {
  readonly exampleName: string;
  readonly configPath?: string;
  readonly sourceRoot?: string;
  readonly runtimeRoot?: string;
  readonly parentEnv?: NodeJS.ProcessEnv;
}

async function resolveConfigOverride(
  source: SourceEvidence,
  configPath: string | undefined,
  parentEnv: NodeJS.ProcessEnv,
): Promise<string> {
  if (configPath === undefined) return source.configPath;
  if (!isAbsolute(configPath)) throw new Error("runtime config override must be absolute");
  let canonical: string;
  try {
    canonical = await realpath(configPath);
  } catch {
    throw new Error("runtime config override must be an existing file");
  }
  await requireFile(canonical, "runtime config override");
  const tmpRoot = join(source.root, "tmp");
  if (!canonical.startsWith(`${tmpRoot}${sep}`)) {
    throw new Error("runtime config override must be inside upstream tmp");
  }
  try {
    await execFileAsync("git", ["-C", source.root, "check-ignore", "-q", "--", canonical], {
      env: scrubbedGitEnvironment(parentEnv),
    });
  } catch {
    throw new Error("runtime config override must be gitignored by the upstream checkout");
  }
  return canonical;
}

async function requireFile(path: string, label: string): Promise<void> {
  let value;
  try {
    value = await stat(path);
  } catch {
    throw new Error(`${label} is missing; build the exact DSH source revision first`);
  }
  if (!value.isFile()) throw new Error(`${label} must be a file`);
}

async function gitOutput(root: string, gitEnv: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    env: gitEnv,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

async function requireCleanDiff(
  root: string,
  gitEnv: NodeJS.ProcessEnv,
  args: string[],
  description: string,
): Promise<void> {
  try {
    await execFileAsync("git", ["-C", root, ...args], { env: gitEnv });
  } catch {
    throw new Error(`DSH source ${description} is dirty`);
  }
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

async function validateSource(
  sourceRoot: string | undefined,
  parentEnv: NodeJS.ProcessEnv,
): Promise<SourceEvidence> {
  if (sourceRoot === undefined || sourceRoot.trim() === "")
    throw new Error("DSH_SOURCE_ROOT is required");
  if (!isAbsolute(sourceRoot)) throw new Error("DSH_SOURCE_ROOT must be an absolute path");
  let root: string;
  try {
    root = await realpath(sourceRoot);
  } catch {
    throw new Error("DSH_SOURCE_ROOT must be an existing directory");
  }

  const gitEnv = scrubbedGitEnvironment(parentEnv);
  await requireCleanDiff(root, gitEnv, ["diff", "--quiet"], "tracked worktree");
  await requireCleanDiff(root, gitEnv, ["diff", "--cached", "--quiet"], "staged index");
  const revision = await gitOutput(root, gitEnv, ["rev-parse", "HEAD"]);
  if (revision !== EXPECTED_DSH_REVISION) {
    throw new Error(`DSH source HEAD must equal ${EXPECTED_DSH_TAG}`);
  }
  const tag = await gitOutput(root, gitEnv, ["rev-parse", `${EXPECTED_DSH_TAG}^{commit}`]);
  if (tag !== EXPECTED_DSH_REVISION || tag !== revision) {
    throw new Error(`DSH source tag ${EXPECTED_DSH_TAG} does not resolve to the required revision`);
  }

  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (manifest.version !== EXPECTED_DSH_VERSION) {
    throw new Error(`DSH root package version must be ${EXPECTED_DSH_VERSION}`);
  }
  const binPath = join(root, "packages/examples/jsonrpc-demo/lib/bin.js");
  const configPath = join(root, "examples/jsonrpc-agent/minimal.cordis.yml");
  await requireFile(binPath, "built runtime bin");
  await requireFile(configPath, "minimal Cordis config");
  return {
    root,
    revision,
    tag: EXPECTED_DSH_TAG,
    version: EXPECTED_DSH_VERSION,
    binPath,
    configPath,
  };
}

function safeExampleName(value: string): string {
  const safe = value.replaceAll(/[^a-zA-Z0-9_-]/g, "-");
  if (safe === "") throw new Error("exampleName must contain at least one safe character");
  return safe;
}

function childEnvironment(parentEnv: NodeJS.ProcessEnv, state: RuntimeState): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = parentEnv[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  const key = parentEnv.DEEPSEEK_API_KEY?.trim();
  if (key === undefined || key === "") throw new Error("DEEPSEEK_API_KEY must be nonempty");
  env.DEEPSEEK_API_KEY = key;
  const baseUrl = parentEnv.DEEPSEEK_BASE_URL?.trim();
  if (baseUrl !== undefined && baseUrl !== "") env.DEEPSEEK_BASE_URL = baseUrl;
  Object.assign(env, {
    HOME: state.home,
    DSH_HOME: state.dshHome,
    DSH_CWD: state.workspace,
    DSH_SESSION_ROOT: state.sessions,
    DSH_MODEL,
    DSH_CONTEXT_WINDOW,
    DSH_SYSTEM_PROMPT,
  });
  return env;
}

export async function resolveRuntimeLaunch(
  options: ResolveRuntimeLaunchOptions,
): Promise<ResolvedRuntimeLaunch> {
  const parentEnv = options.parentEnv ?? process.env;
  const validatedSource = await validateSource(
    options.sourceRoot ?? parentEnv.DSH_SOURCE_ROOT,
    parentEnv,
  );
  const source = {
    ...validatedSource,
    configPath: await resolveConfigOverride(validatedSource, options.configPath, parentEnv),
  };
  const runtimeRoot = resolve(options.runtimeRoot ?? join(import.meta.dirname, "..", ".runtime"));
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, `${safeExampleName(options.exampleName)}-`));
  const state: RuntimeState = {
    runtimeRoot,
    root,
    workspace: join(root, "workspace"),
    sessions: join(root, "sessions"),
    home: join(root, "home"),
    dshHome: join(root, "dsh-home"),
    ownershipToken: randomUUID(),
  };
  try {
    await mkdir(state.workspace);
    await mkdir(state.sessions);
    await mkdir(state.home);
    await mkdir(state.dshHome);
    await writeFile(join(state.root, OWNERSHIP_MARKER), `${state.ownershipToken}\n`, {
      flag: "wx",
    });
    try {
      await stat(join(state.workspace, ".env"));
      throw new Error("fresh runtime workspace must not contain .env");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const env = childEnvironment(parentEnv, state);
    return {
      source,
      state,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
      options: {
        command: process.execPath,
        args: [source.binPath, source.configPath],
        cwd: state.workspace,
        env,
        requestTimeoutMs: 30_000,
        shutdownTimeoutMs: 1_000,
        disposeEofGraceMs: 6_000,
        disposeGraceMs: 3_000,
      },
    };
  } catch (error) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "runtime state initialization and rollback failed",
      );
    }
    throw error;
  }
}

export async function cleanupRuntimeState(state: RuntimeState): Promise<void> {
  const runtimeRoot = resolve(state.runtimeRoot);
  const root = resolve(state.root);
  if (!root.startsWith(`${runtimeRoot}${sep}`) || root === runtimeRoot) {
    throw new Error("refusing to remove a runtime state path outside its tutorial-owned root");
  }
  let rootMetadata;
  try {
    rootMetadata = await lstat(root);
  } catch {
    throw new Error("refusing to remove runtime state whose root does not exist");
  }
  if (rootMetadata.isSymbolicLink()) {
    throw new Error("refusing to remove runtime state through a symbolic link");
  }
  let marker: string;
  try {
    marker = await readFile(join(root, OWNERSHIP_MARKER), "utf8");
  } catch {
    throw new Error("refusing to remove runtime state without its ownership marker");
  }
  if (marker !== `${state.ownershipToken}\n`) {
    throw new Error("refusing to remove runtime state with a mismatched ownership marker");
  }
  await rm(root, { recursive: true, force: true });
}
