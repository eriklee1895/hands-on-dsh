/** Fixed-operation child for the sandbox-isolation experiment. */
import { spawnSync } from "node:child_process";
import { lstat, readFile, readlink, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Paths and one loopback endpoint created by the owning probe. */
export interface ProbeInput {
  readonly workspace: string;
  readonly outside: string;
  readonly temp: string;
  readonly url: string;
  readonly parentPid: number;
  readonly nonce: string;
}

/** An observed operation, with denial reserved for filesystem/OS permission codes. */
export interface Operation {
  readonly status: "allowed" | "denied";
  readonly code?: string;
  readonly value?: string;
}

/** One complete, fixed set of worker observations. */
export interface WorkerReport {
  readonly nonce: string;
  readonly operations: {
    readonly insideWrite: Operation;
    readonly outsideRead: Operation;
    readonly outsideWrite: Operation;
    readonly symlinkWrite: Operation;
    readonly descendantWrite: Operation;
    readonly tempWrite: Operation;
    readonly loopback: Operation;
    readonly parentVisible: Operation;
  };
}

const DENIAL_CODES = new Set(["EPERM", "EACCES", "EROFS"]);
const INPUT_KEYS = ["workspace", "outside", "temp", "url", "parentPid", "nonce"] as const;
const CHILD_CODE = [
  "const { writeFileSync } = require('node:fs');",
  "try {",
  "  writeFileSync(process.argv[1], process.argv[2], 'utf8');",
  "  process.stdout.write(JSON.stringify({ status: 'allowed' }));",
  "} catch (error) {",
  "  if (['EPERM','EACCES','EROFS'].includes(error?.code)) {",
  "    process.stdout.write(JSON.stringify({ status: 'denied', code: error.code }));",
  "  } else {",
  "    process.stderr.write(String(error?.code ?? error?.name ?? 'child failure'));",
  "    process.exitCode = 2;",
  "  }",
  "}",
].join("\n");

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  const value = record(error);
  const code = value?.code;
  if (typeof code === "string") return code;
  return value?.cause === undefined ? undefined : errorCode(value.cause);
}

function denied(error: unknown): Operation | undefined {
  const code = errorCode(error);
  return code !== undefined && DENIAL_CODES.has(code) ? { status: "denied", code } : undefined;
}

async function observe(operation: () => Promise<string | void>): Promise<Operation> {
  try {
    const value = await operation();
    return value === undefined ? { status: "allowed" } : { status: "allowed", value };
  } catch (error) {
    const refusal = denied(error);
    if (refusal !== undefined) return refusal;
    throw error;
  }
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (path !== ".." && !path.startsWith("../") && !path.startsWith("..\\"));
}

/** Parse a single JSON argv and reject ambiguous or non-local targets. */
export function parseInput(raw: string): ProbeInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("worker input must be valid JSON");
  }
  const value = record(parsed);
  if (
    value === undefined ||
    Object.keys(value).sort().join(",") !== [...INPUT_KEYS].sort().join(",")
  ) {
    throw new Error("worker input must contain exactly the fixed probe fields");
  }
  for (const key of ["workspace", "outside", "temp"] as const) {
    if (typeof value[key] !== "string" || !isAbsolute(value[key]) || value[key] === "") {
      throw new Error(key + " must be an absolute path");
    }
  }
  const workspace = resolve(value.workspace as string);
  const outside = resolve(value.outside as string);
  const temp = resolve(value.temp as string);
  if (isInside(workspace, outside) || isInside(workspace, temp) || outside === temp) {
    throw new Error("probe targets must be separate from the workspace");
  }
  if (typeof value.url !== "string") throw new Error("url must be an HTTP loopback URL");
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error("url must be an HTTP loopback URL");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== ""
  ) {
    throw new Error("url must be an HTTP loopback URL with an explicit port");
  }
  if (!Number.isSafeInteger(value.parentPid) || (value.parentPid as number) <= 0) {
    throw new Error("parentPid must be a positive integer");
  }
  if (typeof value.nonce !== "string" || !value.nonce.trim() || value.nonce.length > 256) {
    throw new Error("nonce must be nonempty and at most 256 characters");
  }
  return {
    workspace,
    outside,
    temp,
    url: url.href,
    parentPid: value.parentPid as number,
    nonce: value.nonce,
  };
}

async function ownedSymlinkPath(input: ProbeInput): Promise<string> {
  const link = join(input.workspace, "outside-link.txt");
  const metadata = await lstat(link);
  if (!metadata.isSymbolicLink()) throw new Error("outside-link.txt is not a symlink");
  const target = resolve(dirname(link), await readlink(link));
  if (target !== join(input.outside, "symlink.txt")) {
    throw new Error("outside-link.txt does not target the owned outside file");
  }
  return link;
}

function descendantWrite(input: ProbeInput): Operation {
  const target = join(input.outside, "descendant.txt");
  const child = spawnSync(
    process.execPath,
    ["--input-type=commonjs", "-e", CHILD_CODE, target, input.nonce],
    { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", maxBuffer: 4096 },
  );
  if (child.error !== undefined || child.status !== 0 || child.signal !== null) {
    throw new Error(
      "descendant probe failed or timed out: " +
        String((child.error?.message ?? child.stderr.trim()) || child.signal || child.status),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(child.stdout);
  } catch {
    throw new Error("descendant probe returned unparseable output");
  }
  const report = record(parsed);
  if (report?.status === "allowed" && Object.keys(report).length === 1) {
    return { status: "allowed" };
  }
  if (
    report?.status === "denied" &&
    typeof report.code === "string" &&
    DENIAL_CODES.has(report.code) &&
    Object.keys(report).length === 2
  ) {
    return { status: "denied", code: report.code };
  }
  throw new Error("descendant probe returned an invalid operation");
}

async function loopbackText(url: string): Promise<string> {
  return new Promise((resolveText, reject) => {
    const request = get(url, { signal: AbortSignal.timeout(5000) }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error("loopback server returned HTTP " + String(response.statusCode)));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) {
          response.destroy(new Error("loopback response exceeded 4096 bytes"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolveText(Buffer.concat(chunks).toString("utf8")));
      response.on("error", reject);
    });
    request.on("error", reject);
  });
}

/** Execute only the eight declared effects; unexpected failures abort the probe. */
export async function runWorker(input: ProbeInput): Promise<WorkerReport> {
  const insideWrite = await observe(() =>
    writeFile(join(input.workspace, "inside.txt"), input.nonce, "utf8"),
  );
  const outsideRead = await observe(async () => {
    const content = await readFile(join(input.outside, "canary.txt"), "utf8");
    if (content !== input.nonce) throw new Error("outside canary did not match the nonce");
    return content;
  });
  const outsideWrite = await observe(() =>
    writeFile(join(input.outside, "outside.txt"), input.nonce, "utf8"),
  );
  const symlinkPath = await ownedSymlinkPath(input);
  const symlinkWrite = await observe(() => writeFile(symlinkPath, input.nonce, "utf8"));
  const child = descendantWrite(input);
  const tempWrite = await observe(() =>
    writeFile(join(input.temp, "temp.txt"), input.nonce, "utf8"),
  );
  const loopback = await observe(async () => {
    const content = await loopbackText(input.url);
    if (content !== input.nonce) throw new Error("loopback response did not match the nonce");
    return content;
  });
  let parentVisible: Operation;
  try {
    process.kill(input.parentPid, 0);
    parentVisible = { status: "allowed" };
  } catch (error) {
    const refusal = denied(error);
    if (refusal === undefined) throw error;
    parentVisible = refusal;
  }
  return {
    nonce: input.nonce,
    operations: {
      insideWrite,
      outsideRead,
      outsideWrite,
      symlinkWrite,
      descendantWrite: child,
      tempWrite,
      loopback,
      parentVisible,
    },
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("worker requires exactly one JSON argv");
  process.stdout.write(JSON.stringify(await runWorker(parseInput(process.argv[2]!))) + "\n");
}
