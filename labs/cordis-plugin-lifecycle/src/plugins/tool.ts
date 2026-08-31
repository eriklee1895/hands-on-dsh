import { lstat, mkdir, open, realpath, rm, rmdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";

export const name = "stage4-proof-tool";
export const inject = ["tools"];

export interface Config {
  workspaceRoot: string;
  partitionMode?: "single" | "call";
}

export const Config: Schema<Config> = Schema.object({
  workspaceRoot: Schema.string().required(),
  partitionMode: Schema.union([Schema.const("single"), Schema.const("call")]).default("single"),
});

function resolveProof(
  config: Config,
  exec?: { callId: unknown; agent?: { session: { id: unknown } } },
): { absolutePath: string; relativePath: string } {
  if (!isAbsolute(config.workspaceRoot)) throw new Error("workspaceRoot must be absolute");
  const workspaceRoot = resolve(config.workspaceRoot);
  if ((config.partitionMode ?? "single") === "single") {
    return {
      absolutePath: join(workspaceRoot, "stage4-proof.txt"),
      relativePath: "stage4-proof.txt",
    };
  }
  if (exec?.agent === undefined) throw new Error("call partition mode requires an Agent");
  const digest = createHash("sha256")
    .update(`stage5-proof-v1\0${String(exec.agent.session.id)}\0${String(exec.callId)}`)
    .digest("hex");
  const relativePath = join(digest, "stage4-proof.txt");
  return {
    absolutePath: join(workspaceRoot, relativePath),
    relativePath: relativePath.replaceAll("\\", "/"),
  };
}

export interface ProofFileHandle {
  writeFile(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface ProofFileSystem {
  prepareRoot(path: string, create: boolean): Promise<string>;
  createPartition(path: string): Promise<void>;
  open(path: string): Promise<ProofFileHandle>;
  rm(path: string): Promise<void>;
  removePartition(path: string): Promise<void>;
}

const nodeFileSystem: ProofFileSystem = {
  async prepareRoot(path, create) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error("workspaceRoot must be a real directory");
    if ((metadata.mode & 0o777) !== 0o700) throw new Error("workspaceRoot must have mode 0700");
    return realpath(path);
  },
  async createPartition(path) {
    await mkdir(path, { recursive: false, mode: 0o700 });
  },
  open: async (path) => open(path, "wx", 0o600),
  async rm(path) {
    await rm(path, { force: true });
  },
  async removePartition(path) {
    await rmdir(path);
  },
};

export function createProofTool(
  config: Config,
  fs: ProofFileSystem = nodeFileSystem,
): ToolDefinition {
  if (!isAbsolute(config.workspaceRoot)) throw new Error("workspaceRoot must be absolute");
  return defineTool({
    name: "write_stage4_proof",
    description: "Write deterministic proof content to the deployment-configured proof artifact.",
    parameters: {
      content: { type: "string", required: true, description: "Exact proof content" },
    },
    output: {
      schema: {
        type: "object",
        properties: {
          path: { type: "string", required: true },
          bytes: { type: "integer", required: true },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted();
      const callMode = (config.partitionMode ?? "single") === "call";
      const workspaceRoot = await fs.prepareRoot(config.workspaceRoot, !callMode);
      const proof = resolveProof({ ...config, workspaceRoot }, exec);
      const bytes = Buffer.from(args.content, "utf8");
      const partitionPath = dirname(proof.absolutePath);
      let partitionCreated = false;
      let handle: ProofFileHandle | undefined;
      let fileOwned = false;
      try {
        if (callMode) {
          await fs.createPartition(partitionPath);
          partitionCreated = true;
        }
        exec.signal.throwIfAborted();
        handle = await fs.open(proof.absolutePath);
        fileOwned = true;
        await handle.writeFile(bytes);
        exec.signal.throwIfAborted();
        await handle.close();
        handle = undefined;
      } catch (error) {
        const failures: unknown[] = [error];
        if (handle !== undefined) {
          try {
            await handle.close();
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
        if (fileOwned) {
          try {
            await fs.rm(proof.absolutePath);
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
        if (partitionCreated) {
          try {
            await fs.removePartition(partitionPath);
          } catch (cleanupError) {
            failures.push(cleanupError);
          }
        }
        if (failures.length > 1) throw new AggregateError(failures, "proof attempt cleanup failed");
        throw error;
      }
      return { path: proof.relativePath, bytes: bytes.byteLength };
    },
  });
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(createProofTool(config));
}
