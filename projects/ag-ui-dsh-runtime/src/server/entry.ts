import { EventEmitter } from "node:events";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { createServer, listenLocal } from "./app.js";
import { RunCoordinator } from "./coordinator.js";
import { FakeDshRuntime, type DshRuntimePort } from "./runtime.js";
import { SourceRuntimeManager, type SourceRuntimeManagerOptions } from "./source-runtime.js";
import { AuthoritativeStore } from "./store.js";

export interface ServerOptions {
  runtime: "fake" | "source";
  host: "127.0.0.1" | "localhost" | "::1";
  port: number;
  fakeDelayMs: number;
  serveWeb: boolean;
  stateRoot?: string;
  sourceRoot?: string;
  webRoot?: string;
}

function argumentValue(arguments_: string[], index: number, name: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

export function parseServerOptions(
  arguments_: string[],
  environment: Record<string, string | undefined> = process.env,
): ServerOptions {
  let runtime: ServerOptions["runtime"] | undefined;
  let host: ServerOptions["host"] = "127.0.0.1";
  let port = 4317;
  let fakeDelayMs = 0;
  let serveWeb = false;
  let stateRoot: string | undefined;
  let sourceRoot: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--serve-web") {
      serveWeb = true;
      continue;
    }
    const value = argumentValue(arguments_, index, argument ?? "argument");
    index += 1;
    if (argument === "--runtime") {
      if (value !== "fake" && value !== "source") throw new Error("--runtime must be fake|source");
      runtime = value;
    } else if (argument === "--host") {
      if (value !== "127.0.0.1" && value !== "localhost" && value !== "::1")
        throw new Error("server entry may bind only to loopback");
      host = value;
    } else if (argument === "--port") {
      port = integer(value, "--port", 0, 65_535);
    } else if (argument === "--fake-delay-ms") {
      fakeDelayMs = integer(value, "--fake-delay-ms", 0, 60_000);
    } else if (argument === "--state-root") {
      stateRoot = value;
    } else if (argument === "--source-root") {
      sourceRoot = value;
    } else {
      throw new Error(`unknown argument ${argument}`);
    }
  }
  if (runtime === undefined) throw new Error("--runtime fake|source is required");
  if (runtime === "source") {
    sourceRoot ??= environment.DSH_SOURCE_ROOT;
    if (sourceRoot === undefined || sourceRoot.trim() === "")
      throw new Error("source runtime requires --source-root or DSH_SOURCE_ROOT");
    if (!isAbsolute(sourceRoot)) throw new Error("source runtime root must be absolute");
  }
  return {
    runtime,
    host,
    port,
    fakeDelayMs,
    serveWeb,
    ...(stateRoot === undefined ? {} : { stateRoot }),
    ...(sourceRoot === undefined ? {} : { sourceRoot }),
  };
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

export interface ApplicationServer {
  address: string;
  stateRoot: string;
  app: FastifyInstance;
  store: AuthoritativeStore;
  coordinator: RunCoordinator;
  runtime: DshRuntimePort;
  close(): Promise<void>;
}

export async function createApplicationServer(
  options: ServerOptions,
  dependencies: {
    testOnlySourceRuntimeFactory?: (
      options: SourceRuntimeManagerOptions,
    ) => Promise<DshRuntimePort>;
    environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<ApplicationServer> {
  const root = await projectRoot(import.meta.dirname);
  const ownsStateRoot = options.runtime === "fake" && options.stateRoot === undefined;
  const stateRoot =
    options.stateRoot === undefined
      ? options.runtime === "fake"
        ? await mkdtemp(join(tmpdir(), "hands-on-dsh-agui-"))
        : join(root, ".runtime", "app-state")
      : resolve(options.stateRoot);
  let store: AuthoritativeStore | undefined;
  let coordinator: RunCoordinator | undefined;
  let app: FastifyInstance | undefined;
  let runtime: DshRuntimePort | undefined;
  let closePromise: Promise<void> | undefined;
  const close = () =>
    (closePromise ??= (async () => {
      const errors: unknown[] = [];
      if (app !== undefined) {
        try {
          await app.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (coordinator !== undefined) {
        try {
          await coordinator.shutdown();
        } catch (error) {
          errors.push(error);
        }
      } else if (runtime !== undefined) {
        try {
          await runtime.shutdown();
        } catch (error) {
          errors.push(error);
        }
      }
      if (store !== undefined) {
        try {
          store.close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (ownsStateRoot) {
        try {
          await rm(stateRoot, { recursive: true, force: true });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        const messages = errors.map((error) =>
          error instanceof Error ? error.message : String(error),
        );
        throw new AggregateError(
          errors,
          `application server shutdown failed: ${messages.join("; ")}`,
        );
      }
    })());
  try {
    if (options.runtime === "fake") {
      const workspace = join(stateRoot, "workspace");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      const fake = new FakeDshRuntime(workspace);
      fake.delayMs = options.fakeDelayMs;
      runtime = fake;
    } else {
      const sourceRuntimeFactory =
        dependencies.testOnlySourceRuntimeFactory ??
        SourceRuntimeManager.create.bind(SourceRuntimeManager);
      runtime = await sourceRuntimeFactory({
        sourceRoot: resolve(options.sourceRoot!),
        appStateRoot: stateRoot,
        parentEnv: dependencies.environment ?? process.env,
      });
    }
    store = new AuthoritativeStore(join(stateRoot, "application.sqlite"));
    coordinator = new RunCoordinator(store, runtime);
    const webRoot =
      options.webRoot === undefined
        ? options.serveWeb
          ? join(root, "dist", "web")
          : undefined
        : resolve(options.webRoot);
    app = createServer({ store, coordinator, ...(webRoot === undefined ? {} : { webRoot }) });
    const address = await listenLocal(app, { host: options.host, port: options.port });
    return { address, stateRoot, app, store, coordinator, runtime, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "server startup and cleanup failed");
    }
    throw error;
  }
}

interface SignalSource extends Pick<EventEmitter, "once" | "removeListener"> {}

export function installTerminationHandlers(
  source: SignalSource,
  close: () => Promise<void>,
  onError: (error: unknown) => void,
): () => void {
  let terminationStarted = false;
  const terminate = () => {
    if (terminationStarted) return;
    terminationStarted = true;
    void close().catch(onError);
  };
  source.once("SIGINT", terminate);
  source.once("SIGTERM", terminate);
  return () => {
    source.removeListener("SIGINT", terminate);
    source.removeListener("SIGTERM", terminate);
  };
}

async function main(): Promise<void> {
  const options = parseServerOptions(process.argv.slice(2));
  const server = await createApplicationServer(options);
  process.stdout.write(
    `${JSON.stringify({ address: server.address, runtime: options.runtime, loopbackOnly: true })}\n`,
  );
  installTerminationHandlers(process, server.close, (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}

const entryPath = process.argv[1];
if (entryPath !== undefined && resolve(entryPath) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
