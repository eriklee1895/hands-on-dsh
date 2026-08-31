import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { SessionId, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const official = vi.hoisted(() => ({
  Config: { source: "official" },
  apply: vi.fn(),
}));

vi.mock("@deepseek-ai/dsh-sdk-jsonrpc-server", () => official);

import { Config, apply, inject, name } from "../src/server/sdk-resume-adapter.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  official.apply.mockReset();
});

async function root(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  roots.push(path);
  return realpath(path);
}

function header(id: string, cwd: string) {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 1,
    cwd,
  };
}

function fixture(headers: ReturnType<typeof header>[]) {
  const create = vi.fn(function (this: { marker: string }, options: unknown) {
    if (this.marker !== "agents") throw new Error("create receiver was not bound");
    return Promise.resolve({ route: "create", options });
  });
  const resume = vi.fn(function (this: { marker: string }, options: unknown) {
    if (this.marker !== "agents") throw new Error("resume receiver was not bound");
    return Promise.resolve({ route: "resume", options });
  });
  const registryList = vi.fn(function (this: { marker: string }) {
    return this.marker;
  });
  const agents = { marker: "agents", create, resume, list: registryList };
  const list = vi.fn(async () => headers);
  const contextMethod = vi.fn(function (this: { marker: string }) {
    return this.marker;
  });
  const context = {
    marker: "context",
    agents,
    sessionPersistence: { list },
    contextMethod,
  };
  let proxied: Record<string, any> | undefined;
  official.apply.mockImplementation((received) => {
    proxied = received as unknown as Record<string, any>;
  });
  const config = { maxTokensAsSuccess: false };
  apply(context as unknown as Context, config);
  if (proxied === undefined) throw new Error("official apply did not receive a Context");
  return { agents, config, context, create, list, proxied, resume };
}

describe("SDK resume deployment adapter", () => {
  test("exports the official Config and delegates plugin application through a bound Context", async () => {
    const cwd = await root("sdk-resume-binding-");
    const { agents, config, context, proxied } = fixture([]);

    expect(name).toBe("stage5-sdk-jsonrpc-resume");
    expect(inject).toEqual(["agents", "sessionPersistence"]);
    expect(Config).toBe(official.Config);
    expect(official.apply).toHaveBeenCalledWith(proxied, config);
    expect(proxied.contextMethod()).toBe("context");
    expect(proxied.agents.list()).toBe("agents");
    expect(context.contextMethod).toHaveBeenCalledTimes(1);
    expect(agents.list).toHaveBeenCalledTimes(1);

    await proxied.agents.create({ sessionId: SessionId("fresh"), meta: { cwd } });
  });

  test("creates unchanged when no persisted header has the exact SessionId", async () => {
    const cwd = await root("sdk-resume-create-");
    const { create, list, proxied, resume } = fixture([header("other", cwd)]);
    const options = {
      sessionId: SessionId("fresh"),
      meta: { cwd },
      agentOptions: { model: "model" },
    };

    await expect(proxied.agents.create(options)).resolves.toMatchObject({ route: "create" });

    expect(list).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(options);
    expect(resume).not.toHaveBeenCalled();
  });

  test("resumes an exact persisted SessionId after canonical cwd verification", async () => {
    const cwd = await root("sdk-resume-existing-");
    const aliasParent = await root("sdk-resume-alias-");
    const alias = join(aliasParent, "workspace-link");
    await symlink(cwd, alias, "dir");
    const { create, proxied, resume } = fixture([header("existing", cwd)]);
    const setup = vi.fn();
    const signal = new AbortController().signal;

    await expect(
      proxied.agents.create({
        sessionId: SessionId("existing"),
        meta: { cwd: alias },
        agentOptions: { provider: "provider", model: "model" },
        setup,
        signal,
      }),
    ).resolves.toMatchObject({ route: "resume" });

    expect(resume).toHaveBeenCalledWith({
      resumeSessionId: SessionId("existing"),
      agentOptions: { provider: "provider", model: "model" },
      setup,
      signal,
    });
    expect(create).not.toHaveBeenCalled();
  });

  test("rejects a persisted cwd mismatch without creating or resuming", async () => {
    const requested = await root("sdk-resume-requested-");
    const persisted = await root("sdk-resume-persisted-");
    const { create, proxied, resume } = fixture([header("existing", persisted)]);

    await expect(
      proxied.agents.create({ sessionId: SessionId("existing"), meta: { cwd: requested } }),
    ).rejects.toThrow(/persisted cwd.*requested cwd/i);
    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  test("does not fall back to create after listing or resume fails", async () => {
    const cwd = await root("sdk-resume-failure-");
    const listing = fixture([]);
    listing.list.mockRejectedValueOnce(new Error("list failed"));
    await expect(
      listing.proxied.agents.create({ sessionId: SessionId("existing"), meta: { cwd } }),
    ).rejects.toThrow("list failed");
    expect(listing.create).not.toHaveBeenCalled();

    const resuming = fixture([header("existing", cwd)]);
    resuming.resume.mockRejectedValueOnce(new Error("resume failed"));
    await expect(
      resuming.proxied.agents.create({ sessionId: SessionId("existing"), meta: { cwd } }),
    ).rejects.toThrow("resume failed");
    expect(resuming.create).not.toHaveBeenCalled();
  });
});
