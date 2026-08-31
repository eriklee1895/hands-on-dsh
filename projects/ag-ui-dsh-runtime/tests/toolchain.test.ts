import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("pins one approved AG-UI closure and excludes alternate runtime packages", async () => {
  const root = join(import.meta.dirname, "..");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(manifest.dependencies).toMatchObject({
    "@ag-ui/client": "0.0.57",
    "@ag-ui/core": "0.0.57",
    "@ag-ui/encoder": "0.0.57",
    "@copilotkit/react-core": "1.69.3",
    "@deepseek-ai/dsh-agent": "0.1.1-rc.2",
    "@deepseek-ai/dsh-llm-deepseek": "0.1.1-rc.2",
    "@deepseek-ai/dsh-scope": "0.1.1-rc.2",
    "@deepseek-ai/dsh-sdk-jsonrpc-server": "0.1.1-rc.2",
    "@deepseek-ai/dsh-session-persistence": "0.1.1-rc.2",
    "@deepseek-ai/dsh-subagent": "0.1.1-rc.2",
    "@hands-on-dsh/cordis-plugin-lifecycle": "file:../../labs/cordis-plugin-lifecycle",
  });
  expect(manifest.scripts).toMatchObject({
    "prepare:runtime-attestation": "tsx scripts/prepare-runtime-attestation.ts",
  });
  for (const forbidden of ["@ag-ui/server", "@copilotkit/react-ui", "@copilotkit/runtime"]) {
    expect(manifest.dependencies).not.toHaveProperty(forbidden);
  }
  const lock = await readFile(join(root, "pnpm-lock.yaml"), "utf8");
  expect(lock).not.toMatch(/@ag-ui\+(?:client|core|encoder)@0\.0\.59/);
});
