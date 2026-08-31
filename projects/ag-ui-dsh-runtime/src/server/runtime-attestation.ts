import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { RUNTIME_BARE_PLUGIN_SEEDS } from "./runtime-composition.js";

export const ATTESTATION_RELATIVE_PATH = "tmp/hands-on-dsh-runtime-attestation.json";
export const RUNTIME_PACKAGE_SEEDS = [
  "@deepseek-ai/dsh-sdk-jsonrpc-demo",
  ...RUNTIME_BARE_PLUGIN_SEEDS,
  "@deepseek-ai/dsh-tools",
  "@deepseek-ai/cordis",
  "@deepseek-ai/schemastery",
] as const;

interface FileAttestation {
  path: string;
  sha256: string;
  size: number;
}

interface PackageAttestation {
  name: string;
  version: string;
  root: string;
  manifest: FileAttestation;
  entry: FileAttestation;
  files: Array<FileAttestation & { mode: string }>;
}

export interface RuntimeBuildAttestation {
  schemaVersion: 2;
  source: { revision: string; version: string };
  ownership: { uid: number | null; mode: "0600" };
  host: { platform: NodeJS.Platform; arch: string; nodeMajor: number; nodeAbi: string };
  pnpmLock: FileAttestation;
  runtimeBin: FileAttestation & { mode: string };
  hostPlane: { path: string };
  packages: PackageAttestation[];
  optionalMissing: Array<{ from: string; name: string }>;
}

function relativePath(root: string, path: string): string {
  const value = relative(root, path).replaceAll("\\", "/");
  if (value === "" || value === ".." || value.startsWith("../"))
    throw new Error("attested path must be inside the DSH source");
  return value;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function fileAttestation(root: string, path: string): Promise<FileAttestation> {
  const canonical = await realpath(path);
  if (!canonical.startsWith(`${root}${sep}`)) throw new Error("attested file escaped DSH source");
  const metadata = await lstat(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new Error("attested path must be a regular file");
  return {
    path: relativePath(root, canonical),
    sha256: await sha256(canonical),
    size: metadata.size,
  };
}

function esmExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const selected = esmExportTarget(candidate);
      if (selected !== undefined) return selected;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const root = entries.find(([key]) => key === ".");
  if (root !== undefined) return esmExportTarget(root[1]);
  if (entries.some(([key]) => key.startsWith("."))) return undefined;
  for (const [condition, candidate] of entries) {
    if (!["import", "node", "node-addons", "default"].includes(condition)) continue;
    const selected = esmExportTarget(candidate);
    if (selected !== undefined) return selected;
  }
  return undefined;
}

async function resolveEsmEntry(packageRoot: string, manifest: Record<string, unknown>) {
  const target =
    esmExportTarget(manifest.exports) ??
    (typeof manifest.module === "string"
      ? manifest.module
      : typeof manifest.main === "string"
        ? manifest.main
        : "index.js");
  if (target.startsWith("/") || target === ".." || target.startsWith("../"))
    throw new Error(`runtime package ${String(manifest.name)} has a non-relative ESM entry`);
  return realpath(join(packageRoot, target));
}

async function packageFiles(sourceRoot: string, packageRoot: string) {
  const files: Array<FileAttestation & { mode: string }> = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `runtime package contains an unexpected symlink: ${relativePath(sourceRoot, path)}`,
        );
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile())
        throw new Error(
          `runtime package contains an unsupported filesystem entry: ${relativePath(sourceRoot, path)}`,
        );
      const metadata = await lstat(path);
      files.push({
        ...(await fileAttestation(sourceRoot, path)),
        mode: (metadata.mode & 0o777).toString(8).padStart(4, "0"),
      });
    }
  };
  await visit(packageRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function resolveDependencyRoot(
  sourceRoot: string,
  hostPlane: string,
  parentPackageRoot: string,
  dependency: string,
): Promise<string | undefined> {
  let cursor = parentPackageRoot;
  for (;;) {
    const candidate = join(cursor, "node_modules", ...dependency.split("/"));
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(cursor);
    if (parent === cursor || !parent.startsWith(sourceRoot)) break;
    cursor = parent;
  }
  try {
    return await realpath(join(hostPlane, ...dependency.split("/")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function supportsPlatform(values: unknown, current: string): boolean {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) return true;
  const names = values as string[];
  if (names.includes(`!${current}`)) return false;
  const positive = names.filter((name) => !name.startsWith("!"));
  return positive.length === 0 || positive.includes(current);
}

export async function collectRuntimeBuildAttestation(
  sourceRoot: string,
  expected: { revision: string; version: string },
): Promise<RuntimeBuildAttestation> {
  const root = await realpath(sourceRoot);
  const hostPlane = await realpath(join(root, "node_modules/.pnpm/node_modules"));
  const packages: PackageAttestation[] = [];
  const optionalMissing: Array<{ from: string; name: string }> = [];
  const pending: Array<{ name: string; root: string; optional: boolean }> = await Promise.all(
    RUNTIME_PACKAGE_SEEDS.map(async (name) => ({
      name,
      root: await realpath(join(hostPlane, ...name.split("/"))),
      optional: false,
    })),
  );
  const seen = new Set<string>();
  while (pending.length > 0) {
    const pendingPackage = pending.shift()!;
    const name = pendingPackage.name;
    const packageRoot = pendingPackage.root;
    if (seen.has(packageRoot)) continue;
    seen.add(packageRoot);
    const manifestPath = join(packageRoot, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    if (manifest.name !== name || typeof manifest.version !== "string" || manifest.version === "")
      throw new Error(`runtime package metadata does not match ${name}`);
    if (
      !supportsPlatform(manifest.os, process.platform) ||
      !supportsPlatform(manifest.cpu, process.arch)
    ) {
      if (pendingPackage.optional) continue;
      throw new Error(`required runtime package ${name} does not support this platform`);
    }
    const entryPath = await resolveEsmEntry(packageRoot, manifest);
    packages.push({
      name,
      version: manifest.version,
      root: relativePath(root, packageRoot),
      manifest: await fileAttestation(root, manifestPath),
      entry: await fileAttestation(root, entryPath),
      files: await packageFiles(root, packageRoot),
    });
    for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
      const dependencies = manifest[field];
      if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))
        continue;
      for (const dependency of Object.keys(dependencies as Record<string, unknown>)) {
        const dependencyRoot = await resolveDependencyRoot(
          root,
          hostPlane,
          packageRoot,
          dependency,
        );
        const peerMeta = manifest.peerDependenciesMeta;
        const optionalPeer =
          field === "peerDependencies" &&
          typeof peerMeta === "object" &&
          peerMeta !== null &&
          !Array.isArray(peerMeta) &&
          typeof (peerMeta as Record<string, unknown>)[dependency] === "object" &&
          (peerMeta as Record<string, Record<string, unknown>>)[dependency]?.optional === true;
        const optional = field === "optionalDependencies" || optionalPeer;
        if (dependencyRoot === undefined) {
          if (optional) {
            optionalMissing.push({ from: relativePath(root, packageRoot), name: dependency });
            continue;
          }
          throw new Error(`runtime dependency ${dependency} required by ${name} is missing`);
        }
        pending.push({
          name: dependency,
          root: dependencyRoot,
          optional,
        });
      }
    }
  }
  packages.sort(
    (left, right) => left.name.localeCompare(right.name) || left.root.localeCompare(right.root),
  );
  optionalMissing.sort(
    (left, right) => left.from.localeCompare(right.from) || left.name.localeCompare(right.name),
  );
  const runtimeBinPath = join(root, "packages/examples/jsonrpc-demo/lib/bin.js");
  const runtimeBinMetadata = await lstat(runtimeBinPath);
  const runtimeBin = await fileAttestation(root, runtimeBinPath);
  return {
    schemaVersion: 2,
    source: expected,
    ownership: { uid: process.getuid?.() ?? null, mode: "0600" },
    host: {
      platform: process.platform,
      arch: process.arch,
      nodeMajor: Number(process.versions.node.split(".")[0]),
      nodeAbi: process.versions.modules,
    },
    pnpmLock: await fileAttestation(root, join(root, "pnpm-lock.yaml")),
    runtimeBin: {
      ...runtimeBin,
      mode: (runtimeBinMetadata.mode & 0o777).toString(8).padStart(4, "0"),
    },
    hostPlane: { path: relativePath(root, hostPlane) },
    packages,
    optionalMissing,
  };
}

export async function validateRuntimeBuildAttestation(
  sourceRoot: string,
  expected: { revision: string; version: string },
): Promise<RuntimeBuildAttestation> {
  const root = await realpath(sourceRoot);
  const path = resolve(root, ATTESTATION_RELATIVE_PATH);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new Error("runtime build attestation is missing; run the explicit attestation script");
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600)
    throw new Error("runtime build attestation must be a regular 0600 file");
  const currentUid = process.getuid?.() ?? null;
  if (currentUid !== null && metadata.uid !== currentUid)
    throw new Error("runtime build attestation owner does not match the current user");
  let stored: RuntimeBuildAttestation;
  try {
    stored = JSON.parse(await readFile(path, "utf8")) as RuntimeBuildAttestation;
  } catch (error) {
    throw new Error("runtime build attestation JSON is invalid", { cause: error });
  }
  const current = await collectRuntimeBuildAttestation(root, expected);
  if (JSON.stringify(stored) !== JSON.stringify(current))
    throw new Error("runtime build attestation drift detected; rebuild and attest again");
  return current;
}

export async function writeRuntimeBuildAttestation(
  sourceRoot: string,
  expected: { revision: string; version: string },
): Promise<RuntimeBuildAttestation> {
  const root = await realpath(sourceRoot);
  const document = await collectRuntimeBuildAttestation(root, expected);
  const path = resolve(root, ATTESTATION_RELATIVE_PATH);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.runtime-attestation-${randomUUID()}.json`);
  try {
    await writeFile(temporary, `${JSON.stringify(document, undefined, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await validateRuntimeBuildAttestation(root, expected);
  return document;
}
