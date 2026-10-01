/** Keyless acceptance of the fixed-release SSH filesystem and subprocess providers. */
import { Context } from "@deepseek-ai/cordis";
import { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import { SandboxPolicyService } from "@deepseek-ai/dsh-sandbox-policy";
import { SshConnection } from "@deepseek-ai/dsh-ssh";
import { SshFileSystem } from "@deepseek-ai/dsh-fs-ssh";
import { SshSubprocessRuntime } from "@deepseek-ai/dsh-subprocess-ssh";
import { SshSandboxProvider } from "@deepseek-ai/dsh-sandbox-ssh";

const [helperHash, nonce] = process.argv.slice(2);
if (!helperHash?.match(/^[0-9a-f]{64}$/) || !nonce?.match(/^[0-9a-f]{32}$/)) {
  throw new Error("expected helper digest and probe nonce");
}

const ctx = new Context();
const fibers = [
  ctx.plugin(SessionProjectionRegistry),
  ctx.plugin(SandboxPolicyService, { mode: "workspace-write", workspaceRoot: "/work" }),
  ctx.plugin(SshConnection, {
    host: "dsh-container",
    node: "/usr/local/bin/node",
    helper: "/opt/dsh/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js",
    helperHash,
    workspace: "/work",
  }),
  ctx.plugin(SshFileSystem),
  ctx.plugin(SshSubprocessRuntime),
  ctx.plugin(SshSandboxProvider),
];

try {
  await Promise.all(fibers);
  const file = await ctx.fs.resolve("/work/provider.bin");
  await ctx.fs.writeText(file, nonce);
  if ((await ctx.fs.readText(file)) !== nonce) throw new Error("SSH filesystem bytes differed");

  const handle = ctx.subprocess.spawn({
    argv: [
      "/usr/local/bin/node",
      "-e",
      "require('node:fs').writeFileSync('/work/process.bin', process.argv[1])",
      nonce,
    ],
    cwd: "/work",
    stdio: {
      stdin: "ignore",
      stdout: { maxBytes: 1024 },
      stderr: { maxBytes: 1024 },
    },
    graceMs: 500,
  });
  const result = await handle.done;
  if (result.exitCode !== 0 || !(await handle.waitForExit())) {
    throw new Error("SSH subprocess failed: " + String(result.exitCode));
  }
  let outsideDenied = false;
  try {
    await ctx.fs.readText(await ctx.fs.resolve("/work/../tenant-b/canary"));
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "FS_NOT_FOUND"
    ) {
      throw error;
    }
    outsideDenied = true;
  }
  if (!outsideDenied) throw new Error("tenant B was visible to the SSH filesystem provider");
  process.stdout.write(JSON.stringify({ exitCode: result.exitCode, outsideDenied }) + "\n");
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose();
}
