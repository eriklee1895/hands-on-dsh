/** Real keyless file-effect matrix through the published local sandbox provider. */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { LocalSandboxProvider } from "@deepseek-ai/dsh-sandbox-local";
import { classifyRunnerFailure, type SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { createFixture } from "../src/fixture.ts";
import { runCommand } from "../src/command.ts";
import { validateReport, verifyFiles } from "../src/verification.ts";

if (process.platform !== "darwin")
  throw new Error("Run this macOS matrix on macOS; other platforms are not verified");
const context = new Context();
await context.plugin(LocalSandboxProvider, {});
try {
  for (const mode of [
    "danger-full-access",
    "read-only",
    "workspace-write",
  ] satisfies SandboxMode[]) {
    const fixture = await createFixture();
    let verified = false;
    try {
      const argv = [
        process.execPath,
        fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
        JSON.stringify(fixture.input),
      ];
      const wrapped =
        mode === "danger-full-access"
          ? undefined
          : await context.sandbox.confine(argv, { mode, workspaceRoot: fixture.input.workspace });
      const output = await runCommand(wrapped?.argv ?? argv, fixture.input.workspace);
      if (wrapped && classifyRunnerFailure(output.code, output.stderr, wrapped.runnerFailureRules))
        throw new Error("Sandbox runner failed before the probe; no unconfined fallback");
      assert.equal(
        output.code,
        0,
        "probe must execute successfully; a launch failure is not a denial",
      );
      const result = validateReport(JSON.parse(output.stdout), fixture.input, mode);
      await verifyFiles(fixture.input, mode);
      console.log(
        JSON.stringify({
          mode,
          enforcement: wrapped?.enforcement ?? "unconfined-control",
          runner: wrapped?.argv[0] ?? process.execPath,
          pid: output.pid,
          result,
          externalFilesVerified: true,
        }),
      );
      verified = true;
    } finally {
      await fixture.dispose(verified);
    }
  }
} finally {
  await context.fiber.dispose();
}
