import { readFile } from "node:fs/promises";
import { expect, test } from "vitest";

test("workbench styles namespace muted text and keep the header surface opaque", async () => {
  const styles = await readFile(new URL("../src/web/styles.css", import.meta.url), "utf8");
  expect(styles).toContain("--workbench-muted: #5c687c");
  expect(styles).toMatch(/\.tool-card header span\s*\{[^}]*color: var\(--workbench-muted\)/su);
  expect(styles).not.toContain("var(--muted)");
  expect(styles).toMatch(/\.app-header\s*\{[^}]*background: #fff;/su);
  expect(styles).toMatch(/\.button--warning\s*\{/u);
  expect(styles).not.toContain(".button--workbench-warning");
});
