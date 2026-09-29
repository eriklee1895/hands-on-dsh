import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { parseCommonArguments } from "../src/cli.ts";

const execFileAsync = promisify(execFile);
const root = join(import.meta.dirname, "..");

describe("example CLI", () => {
  test.each([
    "01_explicit_launch.ts",
    "02_reuse_session.ts",
    "03_notification_stream.ts",
    "04_low_level_client.ts",
  ])("%s has keyless help without source-checkout instructions", async (file) => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", `examples/${file}`, "--help"],
      { cwd: root, env: { PATH: process.env.PATH } },
    );
    expect(stderr).toBe("");
    expect(stdout).toContain("--patch");
    expect(stdout).not.toContain("--source-root");
    expect(stdout).not.toContain("DSH_SOURCE_ROOT");
    expect(stdout).not.toContain("/Users/");
  });

  test("parses explicit patch and deadline", () => {
    expect(
      parseCommonArguments(["--patch", "/tmp/profile.patch.yml", "--deadline-ms", "5000"]),
    ).toMatchObject({ patch: "/tmp/profile.patch.yml", deadlineMs: 5000 });
    expect(() => parseCommonArguments(["--deadline-ms", "0"])).toThrow(/正整数/);
  });

  test("example 02 parses a nonempty nonce", () => {
    expect(parseCommonArguments(["--nonce", " SAFFRON "], true)).toMatchObject({
      nonce: "SAFFRON",
    });
    expect(() => parseCommonArguments(["--nonce", "   "], true)).toThrow(/nonce/);
    expect(() => parseCommonArguments(["--nonce", "SAFFRON"])).toThrow(/未知参数/);
    expect(() => parseCommonArguments(["--dsh-bin", "/tmp/fake.mjs"], true)).toThrow(/未知参数/);
  });

  test("redacts a credential echoed in an invalid argument", async () => {
    const key = "fake-parse-key-must-never-appear";
    await expect(
      execFileAsync(process.execPath, ["--import", "tsx", "examples/01_explicit_launch.ts", key], {
        cwd: root,
        env: { PATH: process.env.PATH, DEEPSEEK_API_KEY: key },
      }),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.not.stringContaining(key),
    });
  });
});
