import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  ATTESTATION_RELATIVE_PATH,
  writeRuntimeBuildAttestation,
} from "../src/server/runtime-attestation.ts";

const execFileAsync = promisify(execFile);
const EXPECTED_REVISION = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
const EXPECTED_TAG = "dsh-v0.1.1-rc.2";
const EXPECTED_VERSION = "0.1.1-rc.2";

function childEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const) {
    const value = parent[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  return env;
}

async function git(root: string, env: NodeJS.ProcessEnv, arguments_: string[]) {
  return (
    await execFileAsync("git", ["-C", root, ...arguments_], { env, encoding: "utf8" })
  ).stdout.trim();
}

async function main(): Promise<void> {
  const requested = process.env.DSH_SOURCE_ROOT;
  if (requested === undefined || !isAbsolute(requested))
    throw new Error("DSH_SOURCE_ROOT must be an absolute rc.2 source path");
  const root = await realpath(requested);
  const env = childEnvironment(process.env);
  const revision = await git(root, env, ["rev-parse", "HEAD"]);
  const tag = await git(root, env, ["rev-parse", `${EXPECTED_TAG}^{commit}`]);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (
    revision !== EXPECTED_REVISION ||
    tag !== EXPECTED_REVISION ||
    manifest.version !== EXPECTED_VERSION
  )
    throw new Error("DSH source revision/version does not match rc.2");
  await execFileAsync(
    "git",
    ["-C", root, "check-ignore", "-q", "--", join(root, ATTESTATION_RELATIVE_PATH)],
    { env },
  );
  await execFileAsync("corepack", ["pnpm", "install", "--frozen-lockfile"], { cwd: root, env });
  await execFileAsync("corepack", ["pnpm", "build"], { cwd: root, env });
  await execFileAsync("git", ["-C", root, "diff", "--quiet"], { env });
  await execFileAsync("git", ["-C", root, "diff", "--cached", "--quiet"], { env });
  const document = await writeRuntimeBuildAttestation(root, {
    revision: EXPECTED_REVISION,
    version: EXPECTED_VERSION,
  });
  process.stdout.write(
    `${JSON.stringify({
      attested: true,
      revision: document.source.revision,
      lockSha256: document.pnpmLock.sha256,
      runtimeBinSha256: document.runtimeBin.sha256,
      packageCount: document.packages.length,
    })}\n`,
  );
}

await main();
