import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const enabled = process.env.DSH_CONTAINER_TEST === "1";
const script = fileURLToPath(new URL("../examples/container.sh", import.meta.url));
const realDocker = enabled ? execFileSync("which", ["docker"], { encoding: "utf8" }).trim() : "";

function ownedResource(kind: "container" | "network" | "image", name: string, runId: string) {
  const labels = kind === "network" ? ".Labels" : ".Config.Labels";
  const result = spawnSync(
    realDocker,
    [
      kind,
      "inspect",
      "--format",
      `{{index ${labels} "hands-on-dsh.run"}}|{{index ${labels} "hands-on-dsh.task"}}`,
      name,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return false;
  if (result.stdout.trim() !== `${runId}|container-executor`) {
    throw new Error(`refusing to clean resource without this test's label: ${name}`);
  }
  return true;
}

function failedStart(blockCleanup: boolean) {
  const testRoot = mkdtempSync(join(tmpdir(), "hands-on-dsh-start-failure-"));
  const marker = join(testRoot, "created.txt");
  const wrapper = join(testRoot, "docker");
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == run || "$1" == create ]]; then
  mode="$1"
  shift
  args=()
  name=""
  root=""
  while (( $# )); do
    case "$1" in
      -d) shift ;;
      --name) name="$2"; args+=("$1" "$2"); shift 2 ;;
      type=bind,src=*,dst=/work) root="\${1#type=bind,src=}"; root="\${root%,dst=/work}"; root="\${root%/a}"; args+=("$1"); shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  printf '%s\\n%s\\n' "$name" "$root" > "$DSH_TEST_CREATED_PATH"
  "$DSH_REAL_DOCKER" create "\${args[@]}" >/dev/null
  if [[ "$mode" == run ]]; then exit 19; fi
  exit 0
fi
if [[ "$1" == start ]]; then exit 19; fi
if [[ "\${DSH_TEST_FAIL_RM:-0}" == 1 && ( ( "$1" == rm && "$2" == -f ) || ( "$1" == container && "$2" == rm && "$3" == -f ) ) ]]; then
  echo 'injected Docker remove failure' >&2
  exit 28
fi
exec "$DSH_REAL_DOCKER" "$@"
`,
  );
  chmodSync(wrapper, 0o700);
  const result = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 16_384,
    env: {
      ...process.env,
      PATH: `${testRoot}:${process.env.PATH}`,
      DSH_REAL_DOCKER: realDocker,
      DSH_TEST_CREATED_PATH: marker,
      DSH_TEST_FAIL_RM: blockCleanup ? "1" : "0",
    },
  });
  const [container, root] = readFileSync(marker, "utf8").trim().split("\n") as [string, string];
  const runId = container.slice(0, -4);
  const network = `${runId}-net`;
  const image = `${runId}:local`;
  const exists = (kind: "container" | "network" | "image", name: string) =>
    ownedResource(kind, name, runId);
  const dispose = () => {
    try {
      if (exists("container", container)) execFileSync(realDocker, ["rm", "-f", container]);
      if (exists("network", network)) execFileSync(realDocker, ["network", "rm", network]);
      if (exists("image", image)) execFileSync(realDocker, ["image", "rm", image]);
    } finally {
      if (root.startsWith(join(tmpdir(), "hands-on-dsh-container-"))) {
        rmSync(root, { recursive: true, force: true });
      }
      rmSync(testRoot, { recursive: true, force: true });
    }
  };
  return { result, root, container, network, image, exists, dispose };
}

describe.skipIf(!enabled)("owned Linux container and loopback SSH execution", () => {
  it("keeps tenant B out of the execution world and verifies host-visible artifact bytes", () => {
    const output = execFileSync("bash", [script], {
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 16_384,
    });
    const report = JSON.parse(output) as Record<string, unknown>;
    expect(report).toMatchObject({
      directExit: 0,
      sshExit: 0,
      crossWorkspaceReadExit: 1,
      symlinkReadExit: 1,
      crossWorkspaceWriteDenied: true,
      symlinkWriteDenied: true,
      restrictionsVerified: true,
      limitsVerified: true,
      effectiveUid: 10001,
      artifactBytesVerified: true,
      providerArtifactBytesVerified: true,
      providerCrossWorkspaceDenied: true,
      tenantBUnchanged: true,
      cleanupVerified: true,
    });
    expect(report.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.helperHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.artifactHex).toMatch(/^[0-9a-f]{64}$/);
  }, 180_000);

  it("cleans an owned container when Docker creates it but reports start failure", () => {
    const run = failedStart(false);
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.exists("container", run.container)).toBe(false);
      expect(run.exists("network", run.network)).toBe(false);
      expect(run.exists("image", run.image)).toBe(false);
      expect(existsSync(run.root)).toBe(false);
    } finally {
      run.dispose();
    }
  }, 180_000);

  it("reports an unconfirmed cleanup and retains scratch without the private key", () => {
    const run = failedStart(true);
    try {
      expect(run.result.status).not.toBe(0);
      expect(run.result.stderr).toContain("cleanup incomplete");
      expect(run.result.stderr).toContain(run.root);
      expect(run.exists("container", run.container)).toBe(true);
      expect(existsSync(run.root)).toBe(true);
      expect(existsSync(join(run.root, "client_key"))).toBe(false);
    } finally {
      run.dispose();
    }
  }, 180_000);
});
