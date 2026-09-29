/**
 * Deployment adapter for `dsh-v0.1.7-rc.2` (`477b4f4`). That release's
 * SDK JSON-RPC server always routes a first prompt through `ctx.agents.create()`;
 * this wrapper changes only that call when the exact session is already durable.
 */
import { realpath } from "node:fs/promises";
import type { Context } from "@deepseek-ai/cordis";
import type { CreateAgentOptions } from "@deepseek-ai/dsh-agent";
import type SessionPersistence from "@deepseek-ai/dsh-session-persistence";
import {
  Config as OfficialConfig,
  apply as applyOfficial,
  type JsonRpcConfig,
} from "@deepseek-ai/dsh-sdk-jsonrpc-server";

export const name = "stage5-sdk-jsonrpc-resume";
export const inject = ["agents", "sessionPersistence"];
export const Config: typeof OfficialConfig = OfficialConfig;
export type Config = JsonRpcConfig;

function bindMethods<T extends object>(target: T, override?: Map<PropertyKey, unknown>): T {
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(target, {
    get(original, property) {
      if (override?.has(property) === true) return override.get(property);
      if (bound.has(property)) return bound.get(property);
      const value = Reflect.get(original, property, original) as unknown;
      if (typeof value !== "function") return value;
      const method = value.bind(original) as unknown;
      bound.set(property, method);
      return method;
    },
  });
}

/** Build the Context facade passed to the fixed-release official SDK server. */
export function createResumeAwareContext(ctx: Context): Context {
  const agents = ctx.agents;
  const persistence: SessionPersistence = ctx.sessionPersistence;
  const create = async (options: CreateAgentOptions) => {
    const snapshot = await persistence.stat(options.sessionId, { signal: options.signal });
    if (snapshot === undefined) return agents.create(options);
    const requestedCwd = options.meta?.cwd;
    const persistedCwd = snapshot.header.cwd;
    if (requestedCwd === undefined || persistedCwd === undefined)
      throw new Error(
        `persisted cwd does not match requested cwd for session "${options.sessionId}"`,
      );
    const [canonicalPersistedCwd, canonicalRequestedCwd] = await Promise.all([
      realpath(persistedCwd),
      realpath(requestedCwd),
    ]);
    if (canonicalPersistedCwd !== canonicalRequestedCwd)
      throw new Error(
        `persisted cwd does not match requested cwd for session "${options.sessionId}"`,
      );
    return agents.resume({
      resumeSessionId: options.sessionId,
      agentOptions: options.agentOptions,
      setup: options.setup,
      signal: options.signal,
    });
  };
  const proxiedAgents = bindMethods(agents, new Map([["create", create]]));
  return bindMethods(ctx, new Map([["agents", proxiedAgents]]));
}

/** Delegate the wire server with only resume-aware creation changed. */
export function apply(ctx: Context, config: Config): void {
  applyOfficial(createResumeAwareContext(ctx), config);
}
