/** Start the published profile and close it without submitting a model prompt. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";

const root = await mkdtemp(join(tmpdir(), "hands-on-dsh-handshake-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const harness = new DeepSeekHarness({
  profile: "sdk-minimal",
  dshHome: join(root, "home"),
  cwd: workspace,
  processCwd: workspace,
  model: "deepseek-flash",
  initializeTimeoutMs: 120_000,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    // Handshake validates a route; this placeholder cannot authorize inference.
    DEEPSEEK_API_KEY: "keyless-handshake-placeholder",
  },
});

try {
  await harness.start();
  console.log(
    JSON.stringify({
      profile: "sdk-minimal",
      sdk: "0.1.7-rc.2",
      initialized: true,
      modelRequests: 0,
    }),
  );
} finally {
  // Retain the owned directory if the SDK cannot confirm process exit.
  await harness.close();
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify({ closed: true, temporaryHomeRemoved: true }));
}
