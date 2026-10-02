import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { startOwnedWorker, stopOwnedWorker, waitOwnedWorker } from "./owned-worker.ts";

it.each(["fail", "hang"] as const)(
  "reaps an owned %s inspector before deleting its root",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-inspector-${mode}-`));
    const marker = join(root, "started.txt");
    const code = `const fs=require('node:fs');
fs.writeFileSync(process.argv[1], 'started');
if (process.argv[2] === 'fail') process.exit(7);
setInterval(() => {}, 1000);`;
    const worker = startOwnedWorker(process.execPath, ["-e", code, marker, mode]);
    try {
      const deadline = Date.now() + 2_000;
      let started = false;
      while (!started && Date.now() < deadline) {
        try {
          started = (await readFile(marker, "utf8")) === "started";
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(started).toBe(true);
      if (mode === "fail") {
        expect((await waitOwnedWorker(worker, 1_000)).code).toBe(7);
      } else {
        await expect(waitOwnedWorker(worker, 50)).rejects.toThrow("owned worker deadline");
      }
    } finally {
      const exit = await stopOwnedWorker(worker, 2_000);
      expect(exit.code === 7 || exit.signal === "SIGKILL").toBe(true);
      expect(() => process.kill(worker.child.pid!, 0)).toThrow();
      await rm(root, { recursive: true, force: true });
    }
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  },
  5_000,
);
