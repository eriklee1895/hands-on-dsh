import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationServer } from "../dist/server/server/entry.js";
import { assertExactNonceRecall } from "./real-package-assertions.mjs";

class GateError extends Error {}

function requireValue(condition, label) {
  if (!condition) throw new GateError(label);
}

async function json(response) {
  const value = await response.json();
  requireValue(response.ok, `HTTP ${response.status}`);
  return value;
}

async function awaitTerminal(address, runId) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const run = await json(await fetch(`${address}/api/runs/${runId}`));
    if (["succeeded", "failed", "execution_unknown"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not settle before deadline`);
}

async function submit(address, threadId, runId, prompt, detach = false) {
  const controller = new AbortController();
  const response = await fetch(`${address}/api/ag-ui`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      runId,
      state: {},
      messages: [{ id: `user-${runId}`, role: "user", content: prompt }],
      tools: [],
      context: [],
    }),
    signal: controller.signal,
  });
  requireValue(response.status === 200, `AG-UI admission ${response.status}`);
  if (detach) {
    await response.body.getReader().read();
    controller.abort();
  } else {
    await response.text();
  }
  const run = await awaitTerminal(address, runId);
  requireValue(run.status === "succeeded", `Run ${runId} status ${run.status}`);
  return run;
}

async function verifyRun(server, runId, prompt) {
  const rows = server.store.listEvents(runId, 0, 500);
  const raw = rows.filter((row) => row.channel === "raw-dsh" && row.type === "session.event");
  const calls = raw.filter((row) => row.payload?.params?.event?.type === "tool/call");
  requireValue(calls.length === 1, `Run ${runId} proof call count ${calls.length}`);
  const callId = calls[0].payload.params.event.data.callId;
  const results = raw.filter(
    (row) =>
      row.payload?.params?.event?.type === "tool/result" &&
      row.payload?.params?.event?.data?.message?.toolCallId === callId,
  );
  requireValue(results.length === 1, `Run ${runId} V4 result count ${results.length}`);
  requireValue(results[0].payload.params.event.data.message.isError === false, "proof tool failed");
  const turns = raw.filter((row) => row.payload?.params?.event?.type === "turn/end");
  requireValue(
    turns.at(-1)?.payload?.params?.event?.data?.reason?.kind === "completed",
    "root turn did not complete",
  );
  const artifacts = server.store.listArtifacts(runId);
  requireValue(artifacts.length === 1, `Run ${runId} artifact count ${artifacts.length}`);
  const response = await fetch(`${server.address}/api/artifacts/${artifacts[0].id}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  requireValue(
    response.status === 200 && bytes.equals(Buffer.from(prompt)),
    `Run ${runId} artifact bytes differ`,
  );
  requireValue(artifacts[0].size === bytes.length, `Run ${runId} artifact size differs`);
  requireValue(
    artifacts[0].sha256 === createHash("sha256").update(bytes).digest("hex"),
    `Run ${runId} artifact SHA-256 differs`,
  );
  const audit = (await readFile(join(server.stateRoot, "evidence/tool-audit.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => row.callId === callId);
  requireValue(
    JSON.stringify(audit.map((row) => row.kind)) === '["live","durable"]',
    `Run ${runId} audit pair missing`,
  );
  return { callId, bytes: bytes.length, rows };
}

async function main() {
  requireValue(Boolean(process.env.DEEPSEEK_API_KEY), "DEEPSEEK_API_KEY is required");
  const root = await mkdtemp(join(tmpdir(), "agui-package-e2e-"));
  let server;
  let ownerClosed = false;
  try {
    server = await createApplicationServer({
      runtime: "package",
      host: "127.0.0.1",
      port: 0,
      fakeDelayMs: 0,
      serveWeb: false,
      stateRoot: join(root, "state"),
    });
    const suffix = randomUUID().slice(0, 8);
    const firstId = `e2e-a-${suffix}`;
    const secondId = `e2e-b-${suffix}`;
    for (const id of [firstId, secondId]) {
      const created = await json(
        await fetch(`${server.address}/api/conversations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, title: id }),
        }),
      );
      requireValue(created.id === id, "conversation creation changed identity");
    }
    const nonce = `N${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    const firstPrompt = `Remember the nonce ${nonce}. Call the required proof tool, then reply briefly.`;
    const secondConversationPrompt = `SECOND_CONVERSATION_PROOF_${suffix}`;
    const runA1 = `${firstId}-r1`;
    const runB1 = `${secondId}-r1`;
    await submit(server.address, firstId, runA1, firstPrompt);
    await verifyRun(server, runA1, firstPrompt);
    await submit(server.address, secondId, runB1, secondConversationPrompt);
    await verifyRun(server, runB1, secondConversationPrompt);
    const persistedSession = server.store.getConversation(firstId).dshSessionRef;
    const restarted = await json(
      await fetch(`${server.address}/api/runtime/restart`, { method: "POST" }),
    );
    requireValue(restarted.generation === 2, "runtime generation did not advance once");
    requireValue(
      server.store.getConversation(firstId).dshSessionRef === persistedSession,
      "session reference rotated on idle restart",
    );
    const recallPrompt =
      "What nonce did I ask you to remember in the preceding message? Call the required proof tool, then reply only the nonce.";
    requireValue(!recallPrompt.includes(nonce), "recall prompt leaked nonce");
    const runA2 = `${firstId}-r2`;
    await submit(server.address, firstId, runA2, recallPrompt);
    const recall = await verifyRun(server, runA2, recallPrompt);
    try {
      assertExactNonceRecall(recall.rows, persistedSession, nonce);
    } catch {
      throw new GateError("generation-two last root assistant message was not the exact nonce");
    }
    const lastAguiText = recall.rows
      .filter((row) => row.channel === "ag-ui" && row.type === "TEXT_MESSAGE_CONTENT")
      .at(-1)?.payload?.delta;
    requireValue(
      typeof lastAguiText === "string" && lastAguiText.trim() === nonce,
      "generation-two final AG-UI text is not the exact nonce",
    );
    const detachPrompt = `DETACHED_BUSINESS_REPLAY_${suffix}`;
    const runB2 = `${secondId}-r2`;
    await submit(server.address, secondId, runB2, detachPrompt, true);
    const detached = await verifyRun(server, runB2, detachPrompt);
    const replay = await fetch(`${server.address}/api/runs/${runB2}/stream?after=0`);
    const full = await replay.text();
    const ids = [...full.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    requireValue(
      ids.length > 2 && ids.every((id, index) => index === 0 || id > ids[index - 1]),
      "business cursor is not monotonic",
    );
    const replayRows = [...full.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1]));
    requireValue(
      replayRows.some((row) => row.channel === "business" && row.type === "succeeded"),
      "business replay lacks terminal",
    );
    const after = ids[1];
    const resumed = await (
      await fetch(`${server.address}/api/runs/${runB2}/stream?after=${after}`)
    ).text();
    const resumedIds = [...resumed.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    requireValue(
      JSON.stringify(resumedIds) === JSON.stringify(ids.filter((id) => id > after)),
      "business replay cursor mismatch",
    );
    const health = await readFile(join(server.stateRoot, "evidence/tool-health.jsonl"), "utf8");
    requireValue(health === "", "listener reported a health violation");
    console.log(
      JSON.stringify({
        release: "0.1.7-rc.2",
        conversations: 2,
        successfulRuns: 4,
        generation: restarted.generation,
        sameSessionAfterRestart: true,
        nonceRecalledWithoutPromptLeak: true,
        artifactsExact: 4,
        auditPairs: 4,
        detachBusinessTerminal: true,
        replayedIds: resumedIds.length,
        secondProofBytes: detached.bytes,
      }),
    );
  } finally {
    if (server) {
      await server.close();
      ownerClosed = true;
      await server.runtime.cleanupPersistentState();
    }
    if (ownerClosed) await rm(root, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `real package gate failed: ${error instanceof GateError ? error.message : error instanceof Error ? error.name : "UnknownError"}`,
  );
  process.exitCode = 1;
}
