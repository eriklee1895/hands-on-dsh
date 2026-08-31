import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const runtimeRoot = join(projectRoot, ".runtime");
await mkdir(runtimeRoot, { recursive: true });
const state = await mkdtemp(join(runtimeRoot, "pack-smoke-"));

try {
  await execFileAsync("corepack", ["pnpm", "pack", "--pack-destination", state], {
    cwd: projectRoot,
    env: { PATH: process.env.PATH },
  });
  const tarballName = (await readdir(state)).find((file) => file.endsWith(".tgz"));
  if (tarballName === undefined) throw new Error("pnpm pack produced no tarball");
  const tarball = join(state, tarballName);
  const { stdout: tarEntries } = await execFileAsync("tar", ["-tzf", tarball]);
  const expectedTarEntries = [
    "package/README.md",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/dist/plugins/listener.d.ts",
    "package/dist/plugins/listener.js",
    "package/dist/plugins/tool.d.ts",
    "package/dist/plugins/tool.js",
    "package/dist/proof-journal.d.ts",
    "package/dist/proof-journal.js",
    "package/package.json",
  ];
  const actualTarEntries = tarEntries.trim().split("\n").sort();
  if (JSON.stringify(actualTarEntries) !== JSON.stringify(expectedTarEntries)) {
    throw new Error(`unexpected tar entries: ${JSON.stringify(actualTarEntries)}`);
  }
  const consumer = join(state, "consumer");
  const workspace = join(state, "workspace");
  await mkdir(consumer);
  await mkdir(workspace, { mode: 0o700 });
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify(
      {
        name: "stage4-pack-consumer",
        private: true,
        type: "module",
        packageManager: "pnpm@11.7.0",
        dependencies: {
          "@hands-on-dsh/cordis-plugin-lifecycle": `file:${tarball}`,
          "@deepseek-ai/cordis": "4.0.1",
          "@deepseek-ai/cordis-plugin-include": "1.0.6",
          "@deepseek-ai/cordis-plugin-loader": "1.0.2",
          "@deepseek-ai/dsh-agent": "0.1.1-rc.2",
          "@deepseek-ai/dsh-attachment": "0.1.1-rc.2",
          "@deepseek-ai/dsh-brand": "0.1.1-rc.2",
          "@deepseek-ai/dsh-code-runtime": "0.1.1-rc.2",
          "@deepseek-ai/dsh-invariants": "0.1.1-rc.2",
          "@deepseek-ai/dsh-llm": "0.1.1-rc.2",
          "@deepseek-ai/dsh-scope": "0.1.1-rc.2",
          "@deepseek-ai/dsh-session": "0.1.1-rc.2",
          "@deepseek-ai/dsh-system-prompt": "0.1.1-rc.2",
          "@deepseek-ai/dsh-timeout": "0.1.1-rc.2",
          "@deepseek-ai/dsh-tools": "0.1.1-rc.2",
          "@deepseek-ai/dsh-typert-protocol": "0.1.1-rc.2",
          "@deepseek-ai/dsh-user-approval": "0.1.1-rc.2",
        },
      },
      undefined,
      2,
    ),
  );
  await writeFile(join(consumer, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(
    join(consumer, "loader.mjs"),
    `import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import { pathToFileURL } from "node:url";
const ctx = new Context();
ctx.baseUrl = pathToFileURL(process.cwd()).href + "/";
await ctx.plugin(Loader);
await ctx.loader.create({ name: "@deepseek-ai/cordis-plugin-include", config: { path: "./cordis.yml" } });
`,
  );
  await writeFile(
    join(consumer, "driver.mjs"),
    `export const name = "pack-driver";
export const inject = ["tools"];
export function apply(ctx) {
  void ctx.tools.execute({ callId: "pack-call", name: "write_stage4_proof", arguments: { content: "packed proof\\n" }, signal: new AbortController().signal })
    .then(result => { console.log("pack-smoke=" + JSON.stringify(result.content)); });
}
`,
  );
  await writeFile(
    join(consumer, "cordis.yml"),
    `- id: system-prompt
  name: '@deepseek-ai/dsh-system-prompt'
- id: tools
  name: '@deepseek-ai/dsh-tools'
- id: tool
  name: '@hands-on-dsh/cordis-plugin-lifecycle/tool'
  config:
    workspaceRoot: '${workspace}'
- id: listener
  name: '@hands-on-dsh/cordis-plugin-lifecycle/listener'
  config:
    rootSessionId: 'pack-root'
    toolName: 'write_stage4_proof'
    auditPath: '${join(state, "audit.jsonl")}'
    auditOwnerToken: 'pack-smoke-owner'
- id: driver
  name: './driver.mjs'
`,
  );
  await execFileAsync("corepack", ["pnpm", "install", "--ignore-scripts"], {
    cwd: consumer,
    env: { PATH: process.env.PATH },
  });
  const { stdout, stderr } = await execFileAsync(process.execPath, ["loader.mjs"], {
    cwd: consumer,
    env: { PATH: process.env.PATH },
  });
  if (stderr !== "") throw new Error(`plain-Node Loader wrote stderr: ${stderr}`);
  if (
    !stdout.includes(
      'pack-smoke=[{"type":"text","text":"{\\"path\\":\\"stage4-proof.txt\\",\\"bytes\\":13}"}]',
    )
  ) {
    throw new Error(`unexpected pack smoke output: ${stdout}`);
  }
  if ((await readFile(join(workspace, "stage4-proof.txt"), "utf8")) !== "packed proof\n") {
    throw new Error("packed tool wrote unexpected bytes");
  }
  process.stdout.write("pack-smoke plain-node-loader=yes tool-subpath=yes listener-subpath=yes\n");
} finally {
  await rm(state, { recursive: true, force: true });
}
