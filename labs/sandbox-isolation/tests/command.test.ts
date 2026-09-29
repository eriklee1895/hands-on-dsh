import { expect, it } from "vitest";
import { runCommand } from "../src/command.ts";

it("preserves exit status and output instead of treating failure as confinement", async () => {
  const result = await runCommand(
    [process.execPath, "-e", "console.log('probe'); console.error('broken'); process.exitCode=7"],
    process.cwd(),
  );
  expect(result).toMatchObject({ code: 7, stdout: "probe\n", stderr: "broken\n" });
  await expect(runCommand(["/missing-owned-probe-program"], process.cwd())).rejects.toMatchObject({
    code: "ENOENT",
  });
});
it("ends an owned command when its deadline expires", async () => {
  await expect(
    runCommand([process.execPath, "-e", "setInterval(() => {}, 1000)"], process.cwd(), 100),
  ).rejects.toThrow("deadline");
});

it("rejects and reaps a command that exits while an owned descendant is alive", async () => {
  const script =
    "const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); p.unref();";
  await expect(runCommand([process.execPath, "-e", script], process.cwd())).rejects.toThrow(
    "left descendants",
  );
});
