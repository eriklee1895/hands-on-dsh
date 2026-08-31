import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");

describe("pinned tutorial toolchain", () => {
  test("uses exact rc.2 runtime peers and exact development tools", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(manifest).toMatchObject({
      private: true,
      type: "module",
      packageManager: "pnpm@11.7.0",
      engines: { node: "^22.19.0 || >=24.0.0" },
      scripts: {
        test: "vitest run",
        typecheck: "tsc --noEmit",
        lint: "oxlint --deny-warnings .",
        "format:check": "oxfmt --check .",
      },
      dependencies: {
        "@deepseek-ai/cordis": "4.0.1",
        "@deepseek-ai/dsh-invariants": "0.1.1-rc.2",
        "@deepseek-ai/dsh-llm": "0.1.1-rc.2",
        "@deepseek-ai/dsh-sdk-client": "0.1.1-rc.2",
        "@deepseek-ai/dsh-sdk-protocol": "0.1.1-rc.2",
        "@deepseek-ai/dsh-session": "0.1.1-rc.2",
      },
      devDependencies: {
        "@types/node": "22.20.0",
        oxfmt: "0.65.0",
        oxlint: "1.76.0",
        tsx: "4.22.4",
        typescript: "6.0.3",
        vitest: "4.1.8",
      },
    });
  });

  test("enables strict NodeNext ESM without emit", async () => {
    const config = JSON.parse(await readFile(join(root, "tsconfig.json"), "utf8"));
    expect(config.compilerOptions).toMatchObject({
      allowImportingTsExtensions: true,
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      noUncheckedIndexedAccess: true,
      strict: true,
      target: "ESNext",
      types: ["node"],
      verbatimModuleSyntax: true,
    });
  });

  test("contains no personal absolute source checkout path", async () => {
    const files = ["package.json", "tsconfig.json"];
    for (const file of files) {
      expect(await readFile(join(root, file), "utf8")).not.toContain("/Users/");
    }
  });
});
