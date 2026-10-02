/** Single-writer checkpoints of sanitized observations; not a billing transaction log. */
import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ObservationLedger } from "./core.ts";

const MAX_BYTES = 8 * 1024 * 1024;

/** Replace one checkpoint using a same-directory exclusive temporary file, mode 0600. */
export async function writeSnapshot(path: string, ledger: ObservationLedger): Promise<void> {
  const records = ledger.exportRecords();
  ObservationLedger.fromRecords(records);
  const text = JSON.stringify({ schemaVersion: 1, records }) + "\n";
  if (Buffer.byteLength(text) > MAX_BYTES)
    throw new Error("Observation snapshot exceeds size limit");
  const temporary = join(dirname(path), "." + basename(path) + "." + randomUUID() + ".tmp");
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Load the bounded checkpoint and validate its allowlist before any report is built. */
export async function readSnapshot(path: string): Promise<ObservationLedger> {
  try {
    const handle = await open(path, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) throw new Error("snapshot too large");
      text = buffer.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
    const document: unknown = JSON.parse(text);
    if (typeof document !== "object" || document === null || Array.isArray(document))
      throw new Error("invalid envelope");
    if (
      !("schemaVersion" in document) ||
      document.schemaVersion !== 1 ||
      !("records" in document) ||
      Object.keys(document).length !== 2
    )
      throw new Error("invalid envelope");
    return ObservationLedger.fromRecords(document.records);
  } catch {
    // Parser diagnostics can include source text; callers get no raw payload fragment.
    throw new Error("Invalid observation snapshot");
  }
}
