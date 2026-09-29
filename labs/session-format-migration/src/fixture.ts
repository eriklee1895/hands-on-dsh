import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";

export type FixtureName = "v1" | "v3";

export interface FixtureCopy {
  readonly root: string;
  readonly id: SessionId;
  readonly sourcePath: string;
  readonly directory: string;
  readonly version: 1 | 3;
  generationPath(version: number): string;
  cleanup(): Promise<void>;
}

/** Copy one lab-owned synthetic plaintext fixture into this release's simple no-cwd layout. */
export async function copySyntheticFixture(name: FixtureName): Promise<FixtureCopy> {
  const version = name === "v1" ? 1 : 3;
  const id = SessionId(`synthetic-${name}`);
  const root = await mkdtemp(join(tmpdir(), "hands-on-dsh-session-format-"));
  const directory = join(root, "_no-cwd", id);
  const sourcePath = join(directory, `session.v${version}.jsonl`);
  try {
    await mkdir(directory, { recursive: true });
    await copyFile(
      join(import.meta.dirname, "..", "fixtures", `synthetic-${name}.jsonl`),
      sourcePath,
    );
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    id,
    directory,
    sourcePath,
    version,
    generationPath: (generation) => join(directory, `session.v${generation}.jsonl`),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Mount only the public backend service; this lab does not launch an Agent application. */
export async function mountBackend(root: string, compression?: "none" | "zstd"): Promise<Context> {
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlSessionPersistence, {
      root,
      ...(compression === undefined ? {} : { compression }),
    });
    return ctx;
  } catch (error) {
    await ctx.fiber.dispose();
    throw error;
  }
}
