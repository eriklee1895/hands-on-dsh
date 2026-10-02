/** Submit one explicit prompt with a total activity deadline and owned cleanup. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { RuntimeSupervisor } from "../src/supervisor.ts";

if (!process.env.DEEPSEEK_API_KEY)
  throw new Error("Set DEEPSEEK_API_KEY before running this model example");
const prompt = process.argv[2] ?? "Reply with exactly: runtime supervision ok. Do not call tools.";
const root = await mkdtemp(join(tmpdir(), "hands-on-dsh-supervisor-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const supervisor = new RuntimeSupervisor(
  () =>
    new DeepSeekHarness({
      profile: "sdk-minimal",
      dshHome: join(root, "home"),
      cwd: workspace,
      processCwd: workspace,
      model: process.env.DSH_MODEL ?? "deepseek-flash",
      maxTokens: 4096,
      initializeTimeoutMs: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SystemRoot,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        ...(process.env.DEEPSEEK_BASE_URL
          ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL }
          : {}),
      },
    }),
  180_000,
);

try {
  const result = await supervisor.run(prompt);
  const ending = result.events.filter((event) => event.type === "turn/end").at(-1);
  console.log(
    JSON.stringify(
      {
        generation: supervisor.generation,
        sessionId: result.sessionId,
        finalResponse: result.finalResponse,
        turnEnd: ending?.data.reason,
      },
      null,
      2,
    ),
  );
  if (ending?.data.reason.kind !== "completed") process.exitCode = 1;
} finally {
  await supervisor.close();
  await rm(root, { recursive: true, force: true });
}
