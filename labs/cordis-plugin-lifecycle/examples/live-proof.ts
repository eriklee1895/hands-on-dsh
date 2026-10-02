import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";

const expected = Buffer.from("stage4 deterministic proof\n", "utf8");
const sessionId = "stage4-live-root";
const ownerToken = "stage4-live-owner";

function childEnvironment(home: string): NodeJS.ProcessEnv {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (key === undefined || key === "") throw new Error("DEEPSEEK_API_KEY is required");
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    DEEPSEEK_API_KEY: key,
    ...(process.env.DEEPSEEK_BASE_URL ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } : {}),
  };
}

function patchFor(workspace: string, audit: string, health: string): string {
  const toolModule = join(import.meta.dirname, "..", "dist", "plugins", "tool.js");
  const listenerModule = join(import.meta.dirname, "..", "dist", "plugins", "listener.js");
  return [
    "- id: persistent-bash",
    "  disabled: true",
    "- id: persistent-pwsh",
    "  disabled: true",
    "- insert:",
    "    - id: stage4-proof-tool",
    "      name: " + JSON.stringify(toolModule),
    "      config:",
    "        workspaceRoot: " + JSON.stringify(workspace),
    "    - id: stage4-proof-listener",
    "      name: " + JSON.stringify(listenerModule),
    "      config:",
    "        rootSessionId: " + JSON.stringify(sessionId),
    "        toolName: write_stage4_proof",
    "        auditPath: " + JSON.stringify(audit),
    "        auditOwnerToken: " + JSON.stringify(ownerToken),
    "        healthPath: " + JSON.stringify(health),
    "",
  ].join("\n");
}

async function withDeadline<T>(owner: DeepSeekHarness, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("stage4 turn exceeded 180000ms")), 180_000);
      }),
    ]);
  } catch (error) {
    await owner.close();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function run(handshakeOnly: boolean): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "hands-on-dsh-stage4-live-"));
  const workspace = join(root, "workspace");
  const processHome = join(root, "home");
  const home = join(root, "dsh-home");
  const audit = join(root, "audit.jsonl");
  const health = join(root, "health.jsonl");
  const patch = join(root, "profile.patch.yml");
  let owner: DeepSeekHarness | undefined;
  try {
    await mkdir(workspace, { mode: 0o700 });
    await chmod(workspace, 0o700);
    await mkdir(processHome, { mode: 0o700 });
    await mkdir(home, { mode: 0o700 });
    await writeFile(patch, patchFor(workspace, audit, health));
    await access(join(workspace, "stage4-proof.txt")).then(
      () => {
        throw new Error("proof unexpectedly exists before prompt");
      },
      () => undefined,
    );
    const harness = new DeepSeekHarness({
      profile: "sdk-minimal",
      patches: [patch],
      dshHome: home,
      processCwd: workspace,
      cwd: workspace,
      provider: "deepseek-official",
      model: "deepseek-flash",
      initializeTimeoutMs: 120_000,
      requestTimeoutMs: 30_000,
      env: childEnvironment(processHome),
    });
    owner = harness;
    if (handshakeOnly) {
      await harness.start();
      process.stdout.write(JSON.stringify({ profile: "sdk-minimal", initialized: true }) + "\n");
      return;
    }
    const result = await withDeadline(harness, () =>
      harness.run(
        "Use write_stage4_proof exactly once with content equal to: stage4 deterministic proof\\n. Then briefly confirm. Do not call other tools.",
        { sessionId },
      ),
    );
    const callEvents = result.events.filter((event) => event.type === "tool/call");
    const resultEvents = result.events.filter((event) => event.type === "tool/result");
    const ending = result.events.filter((event) => event.type === "turn/end").at(-1);
    if (
      ending?.data.reason.kind !== "completed" ||
      callEvents.length !== 1 ||
      resultEvents.length !== 1
    ) {
      throw new Error("turn did not complete with exactly one tool call and result");
    }
    const call = callEvents[0]!;
    const durable = resultEvents[0]!;
    const callId = String(call.data.callId);
    if (
      call.data.name !== "write_stage4_proof" ||
      String(durable.data.message.toolCallId) !== callId ||
      durable.data.message.isError
    ) {
      throw new Error("durable tool result does not match successful proof call");
    }
    const output = durable.data.message.content[0];
    const canonical = JSON.stringify({ path: "stage4-proof.txt", bytes: expected.byteLength });
    if (output?.type !== "text" || output.text !== canonical) {
      throw new Error("durable tool result content differs from canonical proof output");
    }
    const bytes = await readFile(join(workspace, "stage4-proof.txt"));
    if (!bytes.equals(expected)) throw new Error("proof file bytes differ from expected content");
    const mode = (await stat(join(workspace, "stage4-proof.txt"))).mode & 0o777;
    if (mode !== 0o600) throw new Error("proof file mode is not 0600");
    const auditRows = (await readFile(audit, "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            kind: string;
            sessionId: string;
            toolName: string;
            callId: string;
          },
      );
    if (
      auditRows.length !== 2 ||
      auditRows[0]?.kind !== "live" ||
      auditRows[1]?.kind !== "durable" ||
      auditRows.some(
        (row) =>
          row.sessionId !== sessionId ||
          row.toolName !== "write_stage4_proof" ||
          row.callId !== callId,
      )
    ) {
      throw new Error("live and durable audit rows do not correlate");
    }
    if ((await readFile(health, "utf8")) !== "")
      throw new Error("listener health recorded a violation");
    process.stdout.write(
      JSON.stringify({
        profile: "sdk-minimal",
        release: "0.1.7-rc.2",
        sessionId,
        toolCalls: callEvents.length,
        toolResults: resultEvents.length,
        callId,
        auditKinds: auditRows.map((row) => row.kind),
        exactBytes: bytes.byteLength,
        mode: mode.toString(8),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        finalResponse: result.finalResponse,
      }) + "\n",
    );
  } finally {
    if (owner !== undefined) await owner.close();
    await rm(root, { recursive: true, force: true });
  }
}

const argument = process.argv[2];
if (argument !== undefined && argument !== "--handshake-only") {
  throw new Error("only --handshake-only is accepted");
}
await run(argument === "--handshake-only");
