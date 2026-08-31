import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-tools";
import Schema from "@deepseek-ai/schemastery";

export const name = "stage4-proof-listener";
export const inject = ["tools"];

export interface Config {
  rootSessionId?: string;
  sessionMode?: "exact" | "all";
  toolName: string;
  auditPath: string;
  auditOwnerToken: string;
  healthPath?: string;
}

export const Config: Schema<Config> = Schema.object({
  rootSessionId: Schema.string(),
  sessionMode: Schema.union([Schema.const("exact"), Schema.const("all")]).default("exact"),
  toolName: Schema.string().default("write_stage4_proof"),
  auditPath: Schema.string().required(),
  auditOwnerToken: Schema.string().required(),
  healthPath: Schema.string(),
});

function appendAudit(config: Config, entry: Record<string, string>): void {
  appendFileSync(config.auditPath, `${JSON.stringify(entry)}\n`);
}

function ensureOwnedHealth(path: string, token: string): void {
  if (!isAbsolute(path)) throw new Error("healthPath must be absolute");
  const ownerPath = `${path}.owner`;
  const fileExists = existsSync(path);
  const ownerExists = existsSync(ownerPath);
  if (fileExists !== ownerExists) throw new Error("health and owner sidecar must exist together");
  if (fileExists) {
    for (const candidate of [path, ownerPath]) {
      const metadata = lstatSync(candidate);
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600)
        throw new Error("health ownership paths must be regular 0600 files");
    }
    if (readFileSync(ownerPath, "utf8") !== token) throw new Error("health owner token mismatch");
    return;
  }
  const owner = openSync(ownerPath, "wx", 0o600);
  writeSync(owner, token);
  closeSync(owner);
  try {
    const health = openSync(path, "wx", 0o600);
    closeSync(health);
  } catch (error) {
    unlinkSync(ownerPath);
    throw error;
  }
}

export function apply(ctx: Context, config: Config): void {
  if ((config.sessionMode ?? "exact") === "exact" && (config.rootSessionId?.trim() ?? "") === "")
    throw new Error("rootSessionId must be nonempty in exact mode");
  if (config.sessionMode === "all" && config.healthPath === undefined)
    throw new Error("healthPath is required in all-session mode");
  if (config.toolName.trim() === "") throw new Error("toolName must be nonempty");
  if (!isAbsolute(config.auditPath)) throw new Error("auditPath must be absolute");
  if (config.auditOwnerToken.trim() === "") throw new Error("auditOwnerToken must be nonempty");
  if (config.healthPath === config.auditPath)
    throw new Error("healthPath must differ from auditPath");
  const ownerPath = `${config.auditPath}.owner`;
  const auditExists = existsSync(config.auditPath);
  const ownerExists = existsSync(ownerPath);
  if (auditExists !== ownerExists) throw new Error("audit and owner sidecar must exist together");
  if (auditExists) {
    for (const path of [config.auditPath, ownerPath]) {
      const metadata = lstatSync(path);
      if (!metadata.isFile()) throw new Error("audit ownership paths must be regular files");
      if ((metadata.mode & 0o777) !== 0o600)
        throw new Error("audit ownership paths must have mode 0600");
    }
    if (readFileSync(ownerPath, "utf8") !== config.auditOwnerToken) {
      throw new Error("audit owner token mismatch");
    }
  } else {
    let ownerCreated = false;
    let auditCreated = false;
    try {
      const owner = openSync(ownerPath, "wx", 0o600);
      ownerCreated = true;
      writeSync(owner, config.auditOwnerToken);
      closeSync(owner);
      const audit = openSync(config.auditPath, "wx", 0o600);
      auditCreated = true;
      closeSync(audit);
    } catch (error) {
      if (auditCreated) unlinkSync(config.auditPath);
      if (ownerCreated) unlinkSync(ownerPath);
      throw error;
    }
  }
  try {
    if (config.healthPath !== undefined)
      ensureOwnedHealth(config.healthPath, config.auditOwnerToken);
  } catch (error) {
    if (!auditExists) {
      unlinkSync(config.auditPath);
      unlinkSync(ownerPath);
    }
    throw error;
  }
  ctx.effect(() => {
    return () => {};
  });

  const slots = new Map<string, string>();
  const completed = new Map<string, Set<string>>();
  const orphaned = new Map<string, string>();
  const existingAudit = readFileSync(config.auditPath, "utf8").trim();
  if (existingAudit !== "") {
    for (const row of existingAudit
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)) {
      if (typeof row.sessionId !== "string" || typeof row.callId !== "string") continue;
      if (row.kind === "live") orphaned.set(row.sessionId, row.callId);
      if (row.kind === "durable") {
        orphaned.delete(row.sessionId);
        const calls = completed.get(row.sessionId) ?? new Set<string>();
        calls.add(row.callId);
        completed.set(row.sessionId, calls);
      }
    }
  }
  if (config.healthPath !== undefined) {
    for (const [sessionId, callId] of orphaned) {
      appendFileSync(
        config.healthPath,
        `${JSON.stringify({
          reason: "orphaned-live-on-reload",
          sessionId,
          callId,
        })}\n`,
      );
    }
  }

  ctx.on("tools/result", (exec) => {
    const violation = (reason: string, sessionId: string, callId: string) => {
      if (config.healthPath !== undefined)
        appendFileSync(config.healthPath, `${JSON.stringify({ reason, sessionId, callId })}\n`);
    };
    if (exec.name !== config.toolName) return;
    const sessionId = String(exec.agent?.session.id ?? "");
    const allSessions = config.sessionMode === "all";
    if (sessionId === "" || (!allSessions && sessionId !== config.rootSessionId)) {
      violation("foreign-session", sessionId, String(exec.callId));
      return;
    }
    const callId = String(exec.callId);
    if (slots.has(sessionId) || completed.get(sessionId)?.has(callId) === true) {
      violation("duplicate-or-concurrent-live", sessionId, callId);
      return;
    }
    try {
      appendAudit(config, { kind: "live", sessionId, toolName: config.toolName, callId });
    } catch {
      violation("audit-append-failed", sessionId, callId);
      return;
    }
    slots.set(sessionId, callId);
  });

  ctx.on("session/event", (session, event) => {
    const sessionId = String(session.id);
    const allSessions = config.sessionMode === "all";
    if ((!allSessions && sessionId !== config.rootSessionId) || event.type !== "tool/result")
      return;
    const block = event.data.message.content[0];
    if (block?.type !== "tool-result") return;
    const callId = String(block.toolCallId);
    if (slots.get(sessionId) !== callId || completed.get(sessionId)?.has(callId) === true) {
      if (config.healthPath !== undefined)
        appendFileSync(
          config.healthPath,
          `${JSON.stringify({ reason: "durable-without-matching-live", sessionId, callId })}\n`,
        );
      return;
    }
    try {
      appendAudit(config, { kind: "durable", sessionId, toolName: config.toolName, callId });
    } catch {
      if (config.healthPath !== undefined)
        appendFileSync(
          config.healthPath,
          `${JSON.stringify({ reason: "audit-append-failed", sessionId, callId })}\n`,
        );
      return;
    }
    slots.delete(sessionId);
    const calls = completed.get(sessionId) ?? new Set<string>();
    calls.add(callId);
    completed.set(sessionId, calls);
  });
}
