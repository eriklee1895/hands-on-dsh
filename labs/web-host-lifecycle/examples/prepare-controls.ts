/** Prepare four fixed commands for manual browser controls; no model calls or writes inside workspace. */
import assert from "node:assert/strict";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = await realpath(process.argv[2] ?? "");
const state: unknown = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
assert.ok(
  typeof state === "object" &&
    state !== null &&
    "kind" in state &&
    state.kind === "web-host-lab" &&
    "root" in state &&
    state.root === root,
);
assert.ok(
  "code" in state && typeof state.code === "string" && /^WEB_[a-f0-9]{32}$/.test(state.code),
);
const code = state.code;
const denied = `printf '%s' '${code}' > denied.txt`;
const allowed = `printf '%s' '${code}' > allowed.txt`;
const cancel = `printf '%s' 'STARTED' > cancel-started.txt; sleep 45; printf '%s' '${code}' > cancel-finished.txt`;
const reconnect = `printf '%s' 'STARTED' > reconnect-started.txt; sleep 12; printf '%s' '${code}' >> reconnect-count.txt`;
const approvalPrompt = (command: string) =>
  `Run exactly this bash command: ${command} . Do not include the final period. Use only bash. First try under the current read-only policy. If that exact command is denied by the sandbox, request workspace-write permission for the exact same command once, with a justification. If the user rejects that request, stop without any other attempt and reply exactly DENIED. If allowed and the write succeeds, reply exactly ALLOWED. Do not change the command or use any alternative tool.`;
const slowPrompt = (command: string, answer: string) =>
  `Call bash exactly once with command: ${command} . Do not include the final period. Set timeoutMs to 60000 and run_in_background to false. Do not call any other tools, do not retry or split the command. If the command completes successfully, reply exactly ${answer}.`;
const cases = {
  denied: { command: denied, prompt: approvalPrompt(denied) },
  allowed: { command: allowed, prompt: approvalPrompt(allowed) },
  cancel: { command: cancel, prompt: slowPrompt(cancel, "CANCEL_FINISHED") },
  reconnect: { command: reconnect, prompt: slowPrompt(reconnect, "RECONNECTED") },
};
await writeFile(join(root, "control-cases.json"), JSON.stringify({ root, code, cases }, null, 2), {
  mode: 0o600,
  flag: "wx",
});
console.log(JSON.stringify({ prepared: 4, file: join(root, "control-cases.json") }));
