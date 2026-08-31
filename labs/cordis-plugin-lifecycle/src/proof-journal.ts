import { watch } from "node:fs";
import { open, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";

declare module "@deepseek-ai/cordis" {
  interface Context {
    proofJournal: ProofJournalService;
  }
  interface Events {
    "proof/recorded"(value: string): void;
    "proof/authorize"(input: string, next: () => Promise<string>): Promise<string>;
  }
}

export class ProofJournalService extends Service {
  readonly records: string[] = [];

  constructor(ctx: Context) {
    super(ctx, "proofJournal");
  }

  record(value: string): void {
    this.records.push(value);
    this.ctx.emit("proof/recorded", value);
  }
}

export function createProofConsumer(observations: string[]) {
  let activations = 0;
  return {
    name: "proof-journal-consumer",
    inject: ["proofJournal"],
    apply(ctx: Context) {
      activations += 1;
      const generation = activations;
      observations.push(`active:${generation}`);
      ctx.on("proof/recorded", (value) => observations.push(`recorded:${value}`));
      ctx.effect(() => () => observations.push(`cleanup:${generation}`));
    },
  };
}

export function createProofPolicy(trace: string[]) {
  return {
    name: "proof-journal-policy",
    apply(ctx: Context) {
      ctx.on("proof/authorize", async (input, next) => {
        trace.push(`observe:${input}`);
        const result = await next();
        if (input === "allow") trace.push("default:allow");
        return result;
      });
      ctx.on("proof/authorize", async (input, next) => {
        if (input === "deny") {
          trace.push("veto:deny");
          return "vetoed";
        }
        return next();
      });
    },
  };
}

export interface ProofResourceOps {
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  open(
    path: string,
  ): Promise<{ appendFile(content: string): Promise<void>; close(): Promise<void> }>;
  watch(path: string): { close(): void };
  startTimer(): unknown;
  stopTimer(timer: unknown): void;
}

const nodeResourceOps: ProofResourceOps = {
  async write(path, content) {
    await writeFile(path, content, { flag: "wx" });
  },
  async remove(path) {
    await rm(path, { force: true });
  },
  open: async (path) => open(path, "a+"),
  watch: (path) => watch(path, () => {}),
  startTimer: () => setInterval(() => {}, 1_000),
  stopTimer: (timer) => clearInterval(timer as NodeJS.Timeout),
};

export function createProofResource(
  config: { resourcePath: string; proofPath: string },
  ops: ProofResourceOps = nodeResourceOps,
) {
  return {
    name: "proof-journal-resource",
    async apply(ctx: Context) {
      await ctx.effect(async () => {
        const rollback: Array<() => void | Promise<void>> = [];
        let handle: Awaited<ReturnType<ProofResourceOps["open"]>>;
        let watcher: ReturnType<ProofResourceOps["watch"]>;
        let timer: unknown;
        try {
          await ops.write(config.proofPath, "preserve me\n");
          rollback.push(() => ops.remove(config.proofPath));
          await ops.write(config.resourcePath, "");
          rollback.push(() => ops.remove(config.resourcePath));
          handle = await ops.open(config.resourcePath);
          rollback.push(() => handle.close());
          await handle.appendFile("opened\n");
          watcher = ops.watch(dirname(config.resourcePath));
          rollback.push(() => watcher.close());
          timer = ops.startTimer();
          rollback.push(() => ops.stopTimer(timer));
        } catch (error) {
          const failures: unknown[] = [];
          for (const dispose of rollback.reverse()) {
            try {
              await dispose();
            } catch (cleanupError) {
              failures.push(cleanupError);
            }
          }
          if (failures.length > 0)
            throw new AggregateError([error, ...failures], "resource acquisition rollback failed");
          throw error;
        }
        return async () => {
          ops.stopTimer(timer);
          watcher.close();
          await handle.appendFile("closed\n");
          await handle.close();
        };
      });
    },
  };
}
