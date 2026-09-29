import { mkdtemp, rm, stat } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { createFixture } from "../src/fixture.ts";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, mkdtemp: vi.fn(fs.mkdtemp) };
});
it.skipIf(process.platform !== "darwin")(
  "removes the first owned directory if second-directory setup fails",
  async () => {
    const real = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let root: string | undefined;
    vi.mocked(mkdtemp).mockImplementationOnce(async (prefix) => {
      root = await real.mkdtemp(prefix);
      return root;
    });
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error("fixture setup failure"));
    try {
      await expect(createFixture()).rejects.toThrow("fixture setup failure");
      expect(root).toBeDefined();
      await expect(stat(root!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    }
  },
);
