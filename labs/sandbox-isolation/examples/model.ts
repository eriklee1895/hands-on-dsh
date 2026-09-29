/** Verify the same matrix through actual persistent Bash tool calls in two fresh runtimes. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness, type RunResult } from "@deepseek-ai/dsh-sdk-client";
import { createFixture } from "../src/fixture.ts";
import { validateReport, verifyFiles } from "../src/verification.ts";

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY)
    throw new Error("Set DEEPSEEK_API_KEY before the model example");
  for (const mode of ["read-only", "workspace-write"] as const) {
    const fixture = await createFixture();
    let harness: DeepSeekHarness | undefined;
    let verified = false;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const osHome = join(fixture.root, "os-home");
      await mkdir(osHome);
      const patch = join(fixture.root, "sandbox.patch.yml");
      await writeFile(
        patch,
        [
          "- id: sandbox-policy",
          "  config:",
          "    mode: " + mode,
          "    workspaceRoot: " + JSON.stringify(fixture.input.workspace),
          "- id: persistent-bash",
          "  config:",
          "    timeoutMs: 15000",
        ].join("\n") + "\n",
      );
      harness = new DeepSeekHarness({
        profile: "sdk-minimal",
        patches: [patch],
        dshHome: join(fixture.root, "dsh-home"),
        cwd: fixture.input.workspace,
        processCwd: fixture.input.workspace,
        model: "deepseek-flash",
        initializeTimeoutMs: 120_000,
        maxTokens: 4096,
        env: {
          PATH: process.env.PATH,
          HOME: osHome,
          TMPDIR: process.env.TMPDIR,
          DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
          ...(process.env.DEEPSEEK_BASE_URL
            ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL }
            : {}),
        },
      });
      const command = [
        process.execPath,
        fileURLToPath(new URL("../dist/worker.js", import.meta.url)),
        JSON.stringify(fixture.input),
      ]
        .map(quote)
        .join(" ");
      const result: RunResult = await Promise.race([
        harness.run(
          "Call bash exactly once with the exact command string below. It is a controlled permission probe over disposable files and a local HTTP server owned by this experiment. Do not edit or repeat the command, request escalation, or call other tools. Then briefly confirm completion.\n" +
            command,
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Model probe activity deadline expired")),
            180_000,
          );
        }),
      ]);
      const calls = result.events.filter((event) => event.type === "tool/call");
      const outputs = result.events.filter((event) => event.type === "tool/result");
      assert.equal(
        result.events.filter((event) => event.type === "turn/end").at(-1)?.data.reason.kind,
        "completed",
      );
      assert.equal(calls.length, 1, "exactly one actual tool call");
      assert.equal(outputs.length, 1, "exactly one durable tool result");
      assert.equal(calls[0]!.data.name, "bash");
      assert.deepEqual(
        JSON.parse(calls[0]!.data.arguments),
        { command },
        "exact command with no escalation fields",
      );
      const message = outputs[0]!.data.message;
      assert.equal(message.toolCallId, calls[0]!.data.callId);
      assert.equal(message.isError, false);
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('{"nonce":'));
      assert.equal(lines.length, 1, "one complete worker report in durable Bash output");
      const report = validateReport(JSON.parse(lines[0]!), fixture.input, mode);
      await verifyFiles(fixture.input, mode);
      console.log(
        JSON.stringify({
          mode,
          sessionId: result.sessionId,
          callId: calls[0]!.data.callId,
          completed: true,
          exactToolCommand: true,
          externalFilesVerified: true,
          report,
        }),
      );
      verified = true;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      try {
        await harness?.close();
        closed = true;
      } finally {
        await fixture.dispose(verified && closed);
      }
    }
  }
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      failed: true,
      error: error instanceof Error ? error.name : "UnknownError",
      automaticRetry: false,
    }),
  );
  process.exitCode = 1;
});
