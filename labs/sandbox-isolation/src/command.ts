/** Own a bounded POSIX probe process and wait for exit even after a timeout. */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export function runCommand(
  argv: readonly string[],
  cwd: string,
  timeoutMs = 15_000,
): Promise<{ code: number | null; stdout: string; stderr: string; pid: number | undefined }> {
  if (!argv[0]) return Promise.reject(new Error("Missing probe program"));
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: cwd, TMPDIR: process.env.TMPDIR },
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | undefined;
    function signalGroup(signal: NodeJS.Signals) {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
          failure ??= new Error("Unable to stop owned probe group", { cause: error });
      }
    }
    function stop(reason: Error) {
      if (failure !== undefined) return;
      failure = reason;
      signalGroup("SIGKILL");
    }
    const timer = setTimeout(() => stop(new Error("Probe deadline expired")), timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > 1_000_000) stop(new Error("Probe output exceeded limit"));
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 1_000_000) stop(new Error("Probe output exceeded limit"));
    });
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      async function finish() {
        function groupAlive(): boolean {
          if (child.pid === undefined) return false;
          try {
            process.kill(-child.pid, 0);
            return true;
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
            throw new Error("Could not confirm owned process group exit", { cause: error });
          }
        }
        if (groupAlive()) {
          failure ??= new Error("Probe left descendants after its main process exited");
          signalGroup("SIGKILL");
          for (let attempt = 0; attempt < 40 && groupAlive(); attempt += 1) await delay(25);
          if (groupAlive()) throw new Error("Owned process group exit remains unconfirmed");
        }
        if (failure !== undefined) throw failure;
        return { code, stdout, stderr, pid: child.pid };
      }
      void finish().then(resolve, reject);
    });
  });
}
