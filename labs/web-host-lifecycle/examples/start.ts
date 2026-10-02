/** Run the official Web profile in a disposable home and keep launch credentials local. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { publicUrl, successfulHostExit } from "../src/evidence.ts";

const require = createRequire(import.meta.url);
interface State {
  kind: "web-host-lab";
  root: string;
  port: number;
  code: string;
}
async function main() {
  assert.ok(process.env.DEEPSEEK_API_KEY, "Set DEEPSEEK_API_KEY");
  let state: State;
  const existing = process.argv[2];
  if (existing) {
    const root = await realpath(existing);
    const input: unknown = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
    assert.ok(
      typeof input === "object" &&
        input !== null &&
        "kind" in input &&
        input.kind === "web-host-lab" &&
        "root" in input &&
        input.root === root,
    );
    assert.ok(
      "port" in input && typeof input.port === "number" && input.port > 0 && input.port < 65536,
    );
    assert.ok(
      "code" in input && typeof input.code === "string" && /^WEB_[a-f0-9]{32}$/.test(input.code),
    );
    state = input as State;
  } else {
    const root = await realpath(await mkdtemp(join(tmpdir(), "dsh-web-host-")));
    state = {
      kind: "web-host-lab",
      root,
      port: 0,
      code: "WEB_" + randomUUID().replaceAll("-", ""),
    };
    await mkdir(join(root, "workspace"));
    await mkdir(join(root, "home"));
    await writeFile(join(root, "state.json"), JSON.stringify(state), { mode: 0o600 });
  }
  const patch = join(state.root, "browse-picker.yml");
  await writeFile(
    patch,
    `# Same picker override as upstream apps/web/tests/pin-browse-picker.overlay.yml.\n- id: directory-picker\n  disabled: true\n- insert:\n    - id: directory-picker-browse\n      name: '@deepseek-ai/dsh-host-directory-picker-browse'\n    - id: ui-directory-picker-browse\n      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'\n`,
  );
  await rm(join(state.root, "bootstrap.url"), { force: true });
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    version: string;
    bin: { dsh: string };
  };
  assert.equal(manifest.version, "0.1.7-rc.2");
  const log = createWriteStream(join(state.root, "host.log"), { flags: "a", mode: 0o600 });
  const child = spawn(
    process.execPath,
    [
      resolve(dirname(manifestPath), manifest.bin.dsh),
      "--profile",
      "web",
      "--patch",
      patch,
      "--no-open",
      "--port",
      String(state.port),
    ],
    {
      cwd: join(state.root, "workspace"),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: join(state.root, "home"),
        TMPDIR: process.env.TMPDIR,
        DSH_HOME: join(state.root, "dsh-home"),
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        ...(process.env.DEEPSEEK_BASE_URL
          ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL }
          : {}),
      },
    },
  );
  let tail = "";
  let ready = false;
  let stopping = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk: Buffer) => {
      log.write(chunk);
      tail = (tail + chunk.toString()).slice(-8192);
      if (ready) return;
      const match = tail.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/);
      if (!match) return;
      ready = true;
      clearTimeout(deadline);
      pending = (async () => {
        const baseUrl = publicUrl(match[0]);
        state.port = Number(new URL(baseUrl).port);
        await writeFile(join(state.root, "bootstrap.url"), match[0], { mode: 0o600 });
        await writeFile(join(state.root, "state.json"), JSON.stringify(state), { mode: 0o600 });
        console.log(
          JSON.stringify({
            labRoot: state.root,
            baseUrl,
            launcherPid: process.pid,
            hostPid: child.pid,
            dsh: manifest.version,
          }),
        );
      })();
      void pending.catch(() => {
        child.kill("SIGTERM");
      });
    });
  const stop = () => {
    if (!stopping) {
      stopping = true;
      child.kill("SIGINT");
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  deadline = setTimeout(() => {
    console.error(JSON.stringify({ startupDeadline: true, labRoot: state.root }));
    stop();
  }, 180000);
  try {
    const exit = await new Promise<{ code: number | null; signal: string | null }>(
      (resolveExit, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolveExit({ code, signal }));
      },
    );
    await pending;
    console.log(JSON.stringify({ hostExited: true, ...exit, labRoot: state.root }));
    if (!successfulHostExit(exit.code, ready, stopping)) process.exitCode = 1;
  } finally {
    clearTimeout(deadline);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    log.end();
  }
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({ failed: true, error: error instanceof Error ? error.name : "UnknownError" }),
  );
  process.exitCode = 1;
});
