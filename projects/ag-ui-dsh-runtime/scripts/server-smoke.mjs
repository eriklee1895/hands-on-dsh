import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(projectRoot, "dist", "server", "server", "entry.js");
const adapterPath = join(projectRoot, "dist", "server", "server", "sdk-resume-adapter.js");
await access(adapterPath);
const adapter = await import(pathToFileURL(adapterPath).href);
if (
  adapter.name !== "stage5-sdk-jsonrpc-resume" ||
  JSON.stringify(adapter.inject) !== JSON.stringify(["agents", "sessionPersistence"]) ||
  adapter.Config === undefined ||
  typeof adapter.apply !== "function"
)
  throw new Error("built SDK resume adapter export shape is invalid");
const foreignCwd = await mkdtemp(join(tmpdir(), "agui-built-smoke-cwd-"));
const child = spawn(
  process.execPath,
  [entry, "--runtime", "fake", "--host", "127.0.0.1", "--port", "0", "--serve-web"],
  {
    cwd: foreignCwd,
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const exit = new Promise((resolve) => {
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

function firstLine() {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`built server start timed out: ${stderr}`)),
      5_000,
    );
    const onData = (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(buffer.slice(0, newline));
    };
    child.stdout.on("data", onData);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`built server exited before ready (${code ?? signal}): ${stderr}`));
    });
  });
}

let smokeError;
let smokeRecord;
try {
  const ready = JSON.parse(await firstLine());
  const address = ready.address;
  if (typeof address !== "string" || ready.runtime !== "fake" || ready.loopbackOnly !== true)
    throw new Error("built server readiness record is invalid");
  const [healthResponse, htmlResponse] = await Promise.all([
    fetch(`${address}/api/health`),
    fetch(address),
  ]);
  const health = await healthResponse.json();
  const html = await htmlResponse.text();
  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/u)?.[1];
  if (
    healthResponse.status !== 200 ||
    health.status !== "last-observed" ||
    "pid" in health ||
    htmlResponse.status !== 200 ||
    !html.includes('id="root"') ||
    assetPath === undefined
  )
    throw new Error("built server health or HTML smoke failed");
  const asset = await fetch(`${address}${assetPath}`);
  if (asset.status !== 200 || (await asset.arrayBuffer()).byteLength === 0)
    throw new Error("built web asset smoke failed");
  smokeRecord = {
    builtServer: "ok",
    builtWeb: "ok",
    foreignCwd: true,
    loopback: true,
    pidExposed: false,
    resumeAdapter: "ok",
  };
} catch (error) {
  smokeError = error;
}

const cleanupErrors = [];
if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
const outcome = await Promise.race([
  exit,
  new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5_000)),
]);
if ("timeout" in outcome) {
  child.kill("SIGKILL");
  cleanupErrors.push(new Error(`built server shutdown timed out: ${stderr}`));
} else if (outcome.code !== 0) {
  cleanupErrors.push(
    new Error(`built server shutdown failed: ${JSON.stringify(outcome)} ${stderr}`),
  );
}
try {
  await rm(foreignCwd, { recursive: true, force: true });
} catch (error) {
  cleanupErrors.push(error);
}
if (smokeError !== undefined || cleanupErrors.length > 0)
  throw new AggregateError(
    [...(smokeError === undefined ? [] : [smokeError]), ...cleanupErrors],
    "built server smoke or cleanup failed",
  );
process.stdout.write(`${JSON.stringify(smokeRecord)}\n`);
