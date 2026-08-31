import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

const projectRoot = join(import.meta.dirname, "..");

test("real Loader diagnoses a missing injected service as PENDING", async () => {
  await mkdir(join(projectRoot, ".runtime"), { recursive: true });
  const root = await mkdtemp(join(projectRoot, ".runtime", "pending-"));
  let child: ChildProcess | undefined;
  try {
    await writeFile(
      join(root, "pending.ts"),
      `export const name = "missing-proof-journal";
export const inject = ["proofJournalMissing"];
export function apply() { throw new Error("PENDING plugin must not apply"); }
`,
    );
    await writeFile(
      join(root, "diagnose.ts"),
      `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export const name = "pending-diagnose";
export function apply(ctx) {
  const deadline = Date.now() + 1000;
  const inspect = () => {
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) {
      if (fiber.name === "missing-proof-journal" && fiber.state === 0) {
        writeFileSync(join(process.cwd(), "diagnosis"), "PENDING:proofJournalMissing\\n");
        process.exit(0);
      }
    }
    if (Date.now() >= deadline) process.exit(2);
    setImmediate(inspect);
  };
  setImmediate(inspect);
}
`,
    );
    await writeFile(
      join(root, "cordis.yml"),
      `- id: pending
  name: './pending.ts'
- id: diagnose
  name: './diagnose.ts'
`,
    );
    const launched = spawn(
      process.execPath,
      ["--import", "tsx", join(projectRoot, "scripts/hmr-child.ts")],
      {
        cwd: root,
        env: { PATH: process.env.PATH },
        stdio: "ignore",
      },
    );
    child = launched;
    const exit = await Promise.race([
      new Promise<number | null>((resolve, reject) => {
        launched.once("exit", resolve);
        launched.once("error", reject);
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("PENDING child timeout")), 2_000),
      ),
    ]);
    expect(exit).toBe(0);
    expect(await readFile(join(root, "diagnosis"), "utf8")).toBe("PENDING:proofJournalMissing\n");
  } finally {
    if (child !== undefined && child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
