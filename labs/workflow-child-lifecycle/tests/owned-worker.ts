/** Test-owned Node workers with bounded exit and cleanup waits. */
import { spawn, type ChildProcess } from "node:child_process";

export interface OwnedExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface OwnedWorker {
  child: ChildProcess;
  exit: Promise<OwnedExit>;
  outcome?: OwnedExit;
  stderr: string;
}

export function startOwnedWorker(command: string, args: string[]): OwnedWorker {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  let resolveExit!: (outcome: OwnedExit) => void;
  const exit = new Promise<OwnedExit>((resolve) => {
    resolveExit = resolve;
  });
  const worker: OwnedWorker = { child, exit, stderr: "" };
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    worker.stderr = (worker.stderr + chunk).slice(-8_192);
  });
  const settle = (outcome: OwnedExit) => {
    if (worker.outcome !== undefined) return;
    worker.outcome = outcome;
    resolveExit(outcome);
  };
  child.once("exit", (code, signal) => settle({ code, signal }));
  child.once("error", (error) => {
    if (child.pid === undefined) settle({ code: null, signal: null, error });
    else worker.stderr = (worker.stderr + error.message).slice(-8_192);
  });
  return worker;
}

export async function waitOwnedWorker(worker: OwnedWorker, timeoutMs: number): Promise<OwnedExit> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      worker.exit,
      new Promise<OwnedExit>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("owned worker deadline")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function stopOwnedWorker(worker: OwnedWorker, timeoutMs: number): Promise<OwnedExit> {
  if (worker.outcome === undefined && worker.child.pid !== undefined) worker.child.kill("SIGKILL");
  return waitOwnedWorker(worker, timeoutMs);
}
