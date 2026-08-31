import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

test("publishes stable named tool and listener subpaths", async () => {
  const root = join(import.meta.dirname, "..");
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  expect(manifest.dependencies).toEqual({ "@deepseek-ai/schemastery": "3.18.1" });
  expect(manifest.peerDependencies).toEqual({
    "@deepseek-ai/cordis": "4.0.1",
    "@deepseek-ai/dsh-session": "0.1.1-rc.2",
    "@deepseek-ai/dsh-tools": "0.1.1-rc.2",
  });
  for (const [name, version] of Object.entries(manifest.peerDependencies)) {
    expect(manifest.devDependencies[name]).toBe(version);
  }
  expect(manifest.exports).toMatchObject({
    "./tool": { default: "./dist/plugins/tool.js", types: "./dist/plugins/tool.d.ts" },
    "./listener": { default: "./dist/plugins/listener.js", types: "./dist/plugins/listener.d.ts" },
  });
  for (const file of ["src/plugins/tool.ts", "src/plugins/listener.ts"]) {
    const source = await readFile(join(root, file), "utf8");
    expect(source).toContain("export const name");
    expect(source).toContain("export const inject");
    expect(source).toContain("export const Config");
    expect(source).toContain("export function apply");
    expect(source).not.toMatch(/export default/);
  }
});
