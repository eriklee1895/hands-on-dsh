/** Own disposable sibling workspaces outside platform temporary write grants. */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import type { ProbeInput } from "./worker.ts";

export async function createFixture() {
  if (process.platform !== "darwin")
    throw new Error(
      "This observation matrix is macOS-only; do not treat another platform as a pass",
    );
  const allocated: string[] = [];
  let server: ReturnType<typeof createServer> | undefined;
  async function allocate(base: string, prefix: string) {
    const path = await mkdtemp(join(base, prefix));
    allocated.push(path);
    return realpath(path);
  }
  try {
    const root = await allocate(homedir(), ".hands-on-dsh-sandbox-");
    const temp = await allocate(tmpdir(), "hands-on-dsh-sandbox-");
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    for (const grant of ["/tmp", tmpdir()]) {
      const rel = relative(await realpath(grant), root);
      if (!rel.startsWith("..") && !isAbsolute(rel)) {
        throw new Error("HOME fixture must be outside platform temporary write grants");
      }
    }
    await mkdir(workspace);
    await mkdir(outside);
    const nonce = "SANDBOX_" + randomUUID();
    await writeFile(join(outside, "canary.txt"), nonce);
    await symlink(join(outside, "symlink.txt"), join(workspace, "outside-link.txt"));
    const listener = createServer((_request, response) => response.end(nonce));
    server = listener;
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing loopback listener");
    const input: ProbeInput = {
      workspace,
      outside,
      temp,
      url: `http://127.0.0.1:${address.port}/`,
      parentPid: process.pid,
      nonce,
    };
    return {
      root,
      input,
      async dispose(remove: boolean) {
        listener.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          listener.close((error) => (error ? reject(error) : resolve())),
        );
        if (remove) {
          await rm(root, { recursive: true });
          await rm(temp, { recursive: true });
        } else console.error(JSON.stringify({ retainedDirectories: [root, temp] }));
      },
    };
  } catch (error) {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server!.close((failure) => (failure ? reject(failure) : resolve())),
      );
    }
    await Promise.all(allocated.map((path) => rm(path, { recursive: true, force: true })));
    throw error;
  }
}
