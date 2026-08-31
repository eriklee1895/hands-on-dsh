import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ATTESTATION_RELATIVE_PATH,
  RUNTIME_PACKAGE_SEEDS,
  collectRuntimeBuildAttestation,
  validateRuntimeBuildAttestation,
} from "../src/server/runtime-attestation.ts";
import { RUNTIME_BARE_PLUGIN_SEEDS } from "../src/server/runtime-composition.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "agui-attestation-"));
  roots.push(root);
  await mkdir(join(root, "packages/examples/jsonrpc-demo/lib"), { recursive: true });
  await mkdir(join(root, "node_modules/.pnpm/node_modules"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "dsh", version: "0.1.1-rc.2" }),
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "packages/examples/jsonrpc-demo/lib/bin.js"), "export {}\n", {
    mode: 0o755,
  });
  const packages = [
    ...RUNTIME_PACKAGE_SEEDS,
    "@deepseek-ai/dsh-app-boot",
    "@deepseek-ai/dsh-agent-loop",
    "@deepseek-ai/cosmokit",
    "@deepseek-ai/node-addon-landlock-run",
    "present-optional-peer",
  ];
  for (const name of packages) {
    const packageRoot = join(root, "node_modules/.pnpm/node_modules", ...name.split("/"));
    await mkdir(packageRoot, { recursive: true });
    const dependencies: Record<string, string> = {};
    const peerDependencies: Record<string, string> = {};
    const peerDependenciesMeta: Record<string, { optional: boolean }> = {};
    const optionalDependencies: Record<string, string> = {};
    if (
      name === "@deepseek-ai/dsh-sdk-jsonrpc-demo" ||
      name === "@deepseek-ai/dsh-sdk-jsonrpc-server"
    )
      dependencies["@deepseek-ai/dsh-app-boot"] = "0.1.1-rc.2";
    if (name === "@deepseek-ai/dsh-agent-spine-demo")
      peerDependencies["@deepseek-ai/dsh-agent-loop"] = "0.1.1-rc.2";
    if (name === "@deepseek-ai/schemastery") dependencies["@deepseek-ai/cosmokit"] = "0.1.1-rc.2";
    if (name === "@deepseek-ai/dsh-sandbox-local")
      dependencies["@deepseek-ai/node-addon-landlock-run"] = "0.1.1-rc.2";
    if (name === "@deepseek-ai/dsh-app-boot") {
      peerDependencies["missing-optional-peer"] = "1.0.0";
      peerDependenciesMeta["missing-optional-peer"] = { optional: true };
      peerDependencies["present-optional-peer"] = "1.0.0";
      peerDependenciesMeta["present-optional-peer"] = { optional: true };
    }
    if (name === "@deepseek-ai/dsh-terminal-bash")
      optionalDependencies["missing-platform-helper"] = "1.0.0";
    const dualEntry = name === "@deepseek-ai/schemastery";
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name,
        version: "0.1.1-rc.2",
        type: "module",
        exports: dualEntry
          ? { ".": { import: "./index.mjs", require: "./index.cjs" } }
          : "./index.js",
        dependencies,
        peerDependencies,
        peerDependenciesMeta,
        optionalDependencies,
      }),
    );
    if (dualEntry) {
      await writeFile(
        join(packageRoot, "index.mjs"),
        `export const name = ${JSON.stringify(name)}\n`,
      );
      await writeFile(join(packageRoot, "index.cjs"), `exports.name = ${JSON.stringify(name)}\n`);
    } else {
      await writeFile(
        join(packageRoot, "index.js"),
        `export const name = ${JSON.stringify(name)}\n`,
      );
    }
    if (name === "@deepseek-ai/node-addon-landlock-run") {
      await mkdir(join(packageRoot, "prebuilds/current"), { recursive: true });
      await writeFile(join(packageRoot, "prebuilds/current/native-addon"), "native-payload\n", {
        mode: 0o755,
      });
    }
  }
  return root;
}

async function writeAttestation(root: string) {
  const document = await collectRuntimeBuildAttestation(root, {
    revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
    version: "0.1.1-rc.2",
  });
  const path = join(root, ATTESTATION_RELATIVE_PATH);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 });
  return path;
}

describe("runtime build attestation", () => {
  test("rejects a source without a fresh attestation", async () => {
    const root = await sourceFixture();
    await expect(
      validateRuntimeBuildAttestation(root, {
        revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        version: "0.1.1-rc.2",
      }),
    ).rejects.toThrow(/attestation is missing/);
  });

  test.each(["bin", "lock", "dependency"] as const)("rejects %s drift", async (kind) => {
    const root = await sourceFixture();
    await writeAttestation(root);
    if (kind === "bin")
      await writeFile(join(root, "packages/examples/jsonrpc-demo/lib/bin.js"), "// drift\n");
    if (kind === "lock") await writeFile(join(root, "pnpm-lock.yaml"), "# drift\n");
    if (kind === "dependency") {
      const name = RUNTIME_PACKAGE_SEEDS[0]!;
      await writeFile(
        join(root, "node_modules/.pnpm/node_modules", ...name.split("/"), "index.js"),
        "// dependency drift\n",
      );
    }
    await expect(
      validateRuntimeBuildAttestation(root, {
        revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        version: "0.1.1-rc.2",
      }),
    ).rejects.toThrow(/attestation drift/);
  });

  test("requires owner-only attestation mode", async () => {
    const root = await sourceFixture();
    const path = await writeAttestation(root);
    await chmod(path, 0o644);
    await expect(
      validateRuntimeBuildAttestation(root, {
        revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        version: "0.1.1-rc.2",
      }),
    ).rejects.toThrow(/0600/);
  });

  test("records the ESM export and recursive runtime dependency closure", async () => {
    const root = await sourceFixture();
    const document = await collectRuntimeBuildAttestation(root, {
      revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
      version: "0.1.1-rc.2",
    });
    const byName = new Map(
      document.packages.map((packageValue) => [packageValue.name, packageValue]),
    );
    expect(byName.get("@deepseek-ai/schemastery")?.entry.path).toMatch(/index\.mjs$/);
    for (const name of [
      "@deepseek-ai/dsh-app-boot",
      "@deepseek-ai/dsh-agent-loop",
      "@deepseek-ai/cosmokit",
      "@deepseek-ai/node-addon-landlock-run",
    ])
      expect(byName.has(name)).toBe(true);
    for (const name of RUNTIME_BARE_PLUGIN_SEEDS) expect(byName.has(name)).toBe(true);
    expect(
      byName
        .get("@deepseek-ai/node-addon-landlock-run")
        ?.files.some((file) => file.path.endsWith("prebuilds/current/native-addon")),
    ).toBe(true);
    expect(document.optionalMissing).toContainEqual({
      from: expect.stringContaining("dsh-terminal-bash"),
      name: "missing-platform-helper",
    });
    expect(document.optionalMissing).toContainEqual({
      from: expect.stringContaining("dsh-app-boot"),
      name: "missing-optional-peer",
    });
    expect(byName.has("present-optional-peer")).toBe(true);
    expect(document.schemaVersion).toBe(2);
    expect(document.host.nodeAbi).toBe(process.versions.modules);
  });

  test("rejects a missing required recursive dependency", async () => {
    const root = await sourceFixture();
    const packageRoot = join(
      root,
      "node_modules/.pnpm/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo",
    );
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    manifest.dependencies["missing-required-runtime"] = "1.0.0";
    await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
    await expect(
      collectRuntimeBuildAttestation(root, {
        revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        version: "0.1.1-rc.2",
      }),
    ).rejects.toThrow(/missing-required-runtime.*missing/);
  });

  test.each([
    ["schemastery ESM", "@deepseek-ai/schemastery", "index.mjs"],
    ["dsh-app-boot", "@deepseek-ai/dsh-app-boot", "index.js"],
    ["dsh-agent-loop", "@deepseek-ai/dsh-agent-loop", "index.js"],
  ] as const)("rejects %s drift", async (_label, name, entry) => {
    const root = await sourceFixture();
    await writeAttestation(root);
    await writeFile(
      join(root, "node_modules/.pnpm/node_modules", ...name.split("/"), entry),
      "// transitive ESM drift\n",
    );
    await expect(
      validateRuntimeBuildAttestation(root, {
        revision: "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e",
        version: "0.1.1-rc.2",
      }),
    ).rejects.toThrow(/attestation drift/);
  });
});
