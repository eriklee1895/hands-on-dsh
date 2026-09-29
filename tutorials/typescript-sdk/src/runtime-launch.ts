import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { HarnessClientOptions } from "@deepseek-ai/dsh-sdk-client";

const OWNERSHIP_MARKER = ".hands-on-dsh-runtime-state";
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
  "SystemRoot",
] as const;

export const DSH_PROVIDER = "deepseek-official";
export const DSH_MODEL = "deepseek-flash";

export interface RuntimeState {
  readonly runtimeRoot: string;
  readonly root: string;
  readonly workspace: string;
  readonly home: string;
  readonly dshHome: string;
  readonly ownershipToken: string;
}

export interface ResolvedRuntimeLaunch {
  readonly options: HarnessClientOptions;
  readonly state: RuntimeState;
  readonly provider: typeof DSH_PROVIDER;
  readonly model: typeof DSH_MODEL;
}

export interface ResolveRuntimeLaunchOptions {
  readonly exampleName: string;
  readonly patches?: readonly string[];
  readonly runtimeRoot?: string;
  readonly parentEnv?: NodeJS.ProcessEnv;
  /** Public SDK override for an explicit test CLI fixture. */
  readonly dshBin?: string;
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
  env.HOME = state.home;
  return env;
}

export async function resolveRuntimeLaunch(
  options: ResolveRuntimeLaunchOptions,
): Promise<ResolvedRuntimeLaunch> {
  const parentEnv = options.parentEnv ?? process.env;
  const runtimeRoot = resolve(options.runtimeRoot ?? join(import.meta.dirname, "..", ".runtime"));
  await mkdir(runtimeRoot, { recursive: true });
  const root = await mkdtemp(join(runtimeRoot, `${safeExampleName(options.exampleName)}-`));
  const state: RuntimeState = {
    runtimeRoot,
    root,
    workspace: join(root, "workspace"),
    home: join(root, "home"),
    dshHome: join(root, "dsh-home"),
    ownershipToken: randomUUID(),
  };
  try {
    await mkdir(state.workspace);
    await mkdir(state.home);
    await mkdir(state.dshHome);
    await writeFile(join(state.root, OWNERSHIP_MARKER), `${state.ownershipToken}\n`, {
      flag: "wx",
    });
    const env = childEnvironment(parentEnv, state);
    for (const patch of options.patches ?? []) {
      if (!isAbsolute(patch)) throw new Error("profile patch must be an absolute path");
    }
    return {
      state,
      provider: DSH_PROVIDER,
      model: DSH_MODEL,
      options: {
        profile: "sdk-minimal",
        dshHome: state.dshHome,
        processCwd: state.workspace,
        env,
        ...(options.patches === undefined ? {} : { patches: [...options.patches] }),
        ...(options.dshBin === undefined ? {} : { dshBin: options.dshBin }),
        initializeTimeoutMs: 120_000,
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
