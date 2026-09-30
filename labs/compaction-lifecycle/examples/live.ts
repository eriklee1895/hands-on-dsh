/** Trigger early pressure compaction, then write a code known only from compacted history. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepSeekHarness, type RunResult } from "@deepseek-ai/dsh-sdk-client";
import { foldSurface, Session, SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { inspectCompaction, inspectBeforeProof, readPersisted } from "../src/verify.ts";

async function bounded(
  owner: DeepSeekHarness,
  operation: () => Promise<RunResult>,
): Promise<RunResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("compaction example activity deadline")),
          180_000,
        );
      }),
    ]);
  } catch (error) {
    await owner.close();
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("Set DEEPSEEK_API_KEY");
  const root = await mkdtemp(join(tmpdir(), "dsh-compaction-"));
  let owner: DeepSeekHarness | undefined;
  let verified = false;
  let closed = false;
  try {
    const workspace = join(root, "workspace");
    const home = join(root, "os-home");
    const dshHome = join(root, "dsh-home");
    await mkdir(workspace);
    await mkdir(home);
    const patch = join(root, "compaction.yml");
    const meter = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-token-meter"));
    const engine = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-compaction-basic"));
    await writeFile(
      patch,
      [
        "- insert:",
        "    - id: lesson-token-meter",
        "      name: " + JSON.stringify(meter),
        "    - id: lesson-compaction",
        "      name: " + JSON.stringify(engine),
        "      config:",
        "        auto: true",
        "        thresholdRatio: 0.002",
        "        headroomTokens: 1024",
        "        retainTokens: 0",
        "        maxTokens: 4096",
        "        compactionRetries: 0",
        "        maxOverflowRetries: 0",
      ].join("\n") + "\n",
    );
    owner = new DeepSeekHarness({
      profile: "sdk-minimal",
      patches: [patch],
      cwd: workspace,
      processCwd: workspace,
      dshHome,
      provider: "deepseek-official",
      model: "deepseek-flash",
      maxTokens: 512,
      initializeTimeoutMs: 120_000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: process.env.TMPDIR,
        DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
        ...(process.env.DEEPSEEK_BASE_URL
          ? { DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL }
          : {}),
      },
    });
    await owner.start();
    const sessionId = "compaction-" + randomUUID();
    const subscription = owner.client.subscribe(
      (note) => note.method === "session.event" && note.params.sessionId === sessionId,
    );
    const events: SessionEvent[] = [];
    function drain() {
      let note;
      while ((note = subscription.tryNext()) !== undefined) {
        if (note.method === "session.event") {
          // The public Session constructor validates the full accumulated log below.
          events.push(note.params.event as SessionEvent);
        }
      }
      Session.create(SessionId(sessionId), events);
    }
    try {
      const session = owner.session(sessionId);
      const code = "COMPACT_" + randomUUID().replaceAll("-", "");
      const noiseMarker = "DISPOSABLE_NOISE_" + randomUUID();
      const noise = Array.from(
        { length: 160 },
        (_, i) =>
          `Disposable archive row ${i}: ${createHash("sha256")
            .update("row-" + i)
            .digest("hex")}. Not needed for future tasks.`,
      ).join("\n");
      const seed = `Keep this exact recovery code for later tasks: ${code}. It is the only important fact in this message. Everything in the disposable archive below may be dropped when summarizing. Reply with exactly READY and do not call tools.\n${noiseMarker}\n${noise}`;
      const first = await bounded(owner, () => session.run(seed));
      drain();
      assert.equal(first.finalResponse.trim(), "READY");
      assert.equal(
        first.events.filter((event) => event.type === "turn/end").at(-1)?.data.reason.kind,
        "completed",
      );
      assert.equal(first.events.filter((event) => event.type === "tool/call").length, 0);
      assert.equal(events.filter((event) => event.type === "compaction/summary").length, 0);
      const seedEvent = events.find(
        (event) =>
          event.type === "user/message" && JSON.stringify(event.data.content).includes(noiseMarker),
      );
      assert.ok(seedEvent?.type === "user/message");
      const firstSnapshot = structuredClone(events);
      const prompt =
        "Write the exact recovery code from our earlier conversation to proof.txt with no trailing newline. Call bash exactly once, using exactly this template with RECOVERY_CODE replaced by that remembered code: printf '%s' 'RECOVERY_CODE' > proof.txt . Do not include the sentence's final period in the command. Do not read any file, environment variable or session log, and do not call any other tool. Then reply with exactly DONE.";
      assert.ok(!prompt.includes(code));
      const second = await bounded(owner, () => session.run(prompt));
      drain();
      assert.equal(second.finalResponse.trim(), "DONE");
      assert.equal(
        second.events.filter((event) => event.type === "turn/end").at(-1)?.data.reason.kind,
        "completed",
      );
      const calls = second.events.filter((event) => event.type === "tool/call");
      const results = second.events.filter((event) => event.type === "tool/result");
      assert.equal(calls.length, 1);
      assert.equal(results.length, 1);
      assert.equal(calls[0]!.data.name, "bash");
      assert.deepEqual(JSON.parse(calls[0]!.data.arguments), {
        command: `printf '%s' '${code}' > proof.txt`,
      });
      assert.equal(results[0]!.data.message.toolCallId, calls[0]!.data.callId);
      assert.equal(results[0]!.data.message.isError, false);
      assert.equal(await readFile(join(workspace, "proof.txt"), "utf8"), code);
      const evidence = inspectCompaction(events, seedEvent.seq, code, noiseMarker);
      const chain = inspectBeforeProof(events, calls[0]!.seq, seedEvent.seq, code, noiseMarker);
      assert.deepEqual(events.slice(0, firstSnapshot.length), firstSnapshot);
      const liveNodes = foldSurface(events).nodes;
      await owner.close();
      closed = true;
      drain();
      const persisted = await readPersisted(join(dshHome, "sessions"), sessionId);
      assert.equal(persisted.header.version, 4);
      for (const event of events) assert.deepEqual(persisted.events[event.seq], event);
      const reloaded = inspectCompaction(persisted.events, seedEvent.seq, code, noiseMarker);
      assert.deepEqual(reloaded.surfaceNodes, liveNodes);
      console.log(
        JSON.stringify(
          {
            sdk: "0.1.7-rc.2",
            sessionId,
            trigger: "pressure",
            ...evidence,
            ...chain,
            eventCount: persisted.events.length,
            originalPrefixUnchanged: true,
            reopenedViaPublishedBackend: true,
            replaySurfaceEqual: true,
            subsequentTurnCompleted: true,
            toolCalls: 1,
            artifactBytes: Buffer.byteLength(code),
            artifactSha256: createHash("sha256").update(code).digest("hex"),
          },
          null,
          2,
        ),
      );
      verified = true;
    } finally {
      subscription.close();
    }
  } finally {
    let removed = false;
    try {
      if (!closed && owner !== undefined) {
        await owner.close();
        closed = true;
      }
    } finally {
      try {
        if (verified && closed) {
          await rm(root, { recursive: true, force: true });
          removed = true;
        }
      } finally {
        if (!removed) console.error(JSON.stringify({ retainedDirectory: root, closed }));
      }
    }
  }
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      failed: true,
      error: error instanceof Error ? error.name : "UnknownError",
      automaticRetry: false,
    }),
  );
  process.exitCode = 1;
});
