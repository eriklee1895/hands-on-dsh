import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createApplicationServer,
  installTerminationHandlers,
  parseServerOptions,
} from "../src/server/entry.ts";
import { FakeDshRuntime } from "../src/server/runtime.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("server options", () => {
  test("requires an explicit fake or source runtime and keeps the host on loopback", () => {
    expect(() => parseServerOptions([], {})).toThrow(/--runtime fake\|source is required/);
    expect(() => parseServerOptions(["--runtime", "other"], {})).toThrow(/fake\|source/);
    expect(() => parseServerOptions(["--runtime", "fake", "--host", "0.0.0.0"], {})).toThrow(
      /loopback/,
    );
    expect(
      parseServerOptions(["--runtime", "fake", "--port", "0", "--fake-delay-ms", "25"], {}),
    ).toMatchObject({
      runtime: "fake",
      host: "127.0.0.1",
      port: 0,
      fakeDelayMs: 25,
    });
    expect(() => parseServerOptions(["--runtime", "source"], {})).toThrow(
      /source-root|DSH_SOURCE_ROOT/i,
    );
    expect(() =>
      parseServerOptions(["--runtime", "source", "--source-root", "relative/dsh"], {}),
    ).toThrow(/absolute/);
    expect(
      parseServerOptions(["--runtime", "source", "--serve-web"], {
        DSH_SOURCE_ROOT: "/disposable/dsh",
      }),
    ).toMatchObject({ runtime: "source", sourceRoot: "/disposable/dsh", serveWeb: true });
  });
});

describe("owned fake server", () => {
  test("uses fresh temporary state and memoizes complete loopback shutdown", async () => {
    const server = await createApplicationServer({
      runtime: "fake",
      host: "127.0.0.1",
      port: 0,
      fakeDelayMs: 25,
      serveWeb: false,
    });
    const stateRoot = server.stateRoot;
    expect((await stat(stateRoot)).isDirectory()).toBe(true);
    expect(server.address).toMatch(/^http:\/\/127\.0\.0\.1:/u);
    expect(server.runtime).toBeInstanceOf(FakeDshRuntime);
    expect((server.runtime as FakeDshRuntime).delayMs).toBe(25);

    const first = server.close();
    const second = server.close();
    expect(first).toBe(second);
    await first;

    await expect(access(stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => server.store.listConversations()).toThrow();
  });

  test("a termination signal closes Fastify, coordinator, store and temporary state", async () => {
    const server = await createApplicationServer({
      runtime: "fake",
      host: "127.0.0.1",
      port: 0,
      fakeDelayMs: 0,
      serveWeb: false,
    });
    const signals = new EventEmitter();
    const errors: unknown[] = [];
    const close = vi.fn(server.close);
    const dispose = installTerminationHandlers(signals, close, (error) => {
      errors.push(error);
    });

    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await server.close();
    dispose();

    expect(errors).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(access(server.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(server.coordinator.subscriptions.signal.aborted).toBe(true);
  });

  test("continues store and temporary-root cleanup when Fastify close reports an error", async () => {
    const server = await createApplicationServer({
      runtime: "fake",
      host: "127.0.0.1",
      port: 0,
      fakeDelayMs: 0,
      serveWeb: false,
    });
    const originalClose = server.app.close.bind(server.app);
    vi.spyOn(server.app as unknown as { close(): Promise<void> }, "close").mockImplementation(
      async () => {
        await originalClose();
        throw new Error("close diagnostic");
      },
    );

    await expect(server.close()).rejects.toThrow(/close diagnostic/);

    await expect(access(server.stateRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => server.store.listConversations()).toThrow();
  });

  test("serves the production web bundle and APIs from the same loopback origin", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "agui-web-root-"));
    roots.push(webRoot);
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "index.html"), '<main id="root">built web</main>');
    await writeFile(join(webRoot, "assets", "app.js"), "globalThis.__built = true;");
    const server = await createApplicationServer({
      runtime: "fake",
      host: "127.0.0.1",
      port: 0,
      fakeDelayMs: 0,
      serveWeb: false,
      webRoot,
    });

    expect(await (await fetch(server.address)).text()).toContain("built web");
    expect(await (await fetch(`${server.address}/assets/app.js`)).text()).toContain("__built");
    await expect((await fetch(`${server.address}/api/health`)).json()).resolves.toMatchObject({
      status: "last-observed",
    });
    expect((await fetch(`${server.address}/api/missing`)).status).toBe(404);
    await server.close();
  });

  test("source mode delegates only to the explicit trusted source-runtime factory", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "agui-source-entry-"));
    roots.push(stateRoot);
    const workspace = join(stateRoot, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    const factory = vi.fn(async () => new FakeDshRuntime(workspace));
    const server = await createApplicationServer(
      {
        runtime: "source",
        host: "127.0.0.1",
        port: 0,
        fakeDelayMs: 0,
        serveWeb: false,
        stateRoot,
        sourceRoot: "/disposable/dsh",
      },
      { testOnlySourceRuntimeFactory: factory },
    );

    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({ sourceRoot: "/disposable/dsh", appStateRoot: stateRoot }),
    );
    expect(server.runtime).toBeInstanceOf(FakeDshRuntime);
    await server.close();
    await expect(access(stateRoot)).resolves.toBeUndefined();
  });
});
