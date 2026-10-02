/** One bounded long-input request: distinguish a service rejection from injected/local overflow. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { startTransport } from "../../attachment-input/src/transport.ts";
import { readPersisted } from "../src/verify.ts";
import { verifyRemoteOverflow, saveAndCloseTransport } from "../src/provider-overflow.ts";
async function main() {
  const key = process.env.DEEPSEEK_API_KEY;
  assert.ok(key, "Set DEEPSEEK_API_KEY");
  const root = await mkdtemp(join(tmpdir(), "dsh-provider-overflow-"));
  const cwd = join(root, "workspace"),
    home = join(root, "home"),
    dshHome = join(root, "dsh-home");
  let owner: DeepSeekHarness | undefined;
  let proxy: Awaited<ReturnType<typeof startTransport>> | undefined;
  let closed = true,
    verified = false;
  try {
    await mkdir(cwd);
    await mkdir(home);
    proxy = await startTransport(
      process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/anthropic",
      key,
      join(root, "cleanup.json"),
    );
    const patch = join(root, "overflow.json");
    await writeFile(
      patch,
      JSON.stringify([
        {
          id: "llm-deepseek",
          config: {
            apiKeyEnv: "DEEPSEEK_API_KEY",
            models: [
              {
                id: "deepseek-flash",
                name: "DeepSeek Flash overflow probe",
                contextWindow: 4000000,
                inputModalities: ["text"],
              },
            ],
            maxTokens: 16,
            reasoningEffort: "off",
            streamIdleTimeoutMs: 120000,
            retryPolicy: { mode: "normal", maxRetries: 0 },
          },
        },
        { id: "persistent-bash", disabled: true },
        { id: "persistent-pwsh", disabled: true },
      ]),
    );
    owner = new DeepSeekHarness({
      profile: "sdk-minimal",
      patches: [patch],
      cwd,
      processCwd: cwd,
      dshHome,
      provider: "deepseek-official",
      model: "deepseek-flash",
      reasoningEffort: ReasoningEffortId("off"),
      maxTokens: 16,
      initializeTimeoutMs: 60000,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: process.env.TMPDIR,
        DEEPSEEK_API_KEY: key,
        DEEPSEEK_BASE_URL: proxy.url,
      },
    });
    closed = false;
    await owner.start();
    const sessionId = "overflow-" + randomUUID();
    const events: SessionEvent[] = [];
    const sub = owner.client.subscribe(
      (note) => note.method === "session.event" && note.params.sessionId === sessionId,
    );
    const drain = () => {
      let note;
      while ((note = sub.tryNext()) !== undefined)
        if (note.method === "session.event") events.push(note.params.event as SessionEvent);
    };
    // This count is a fixed probe input, not a claim about the server's tokenizer or limit.
    const repeatedFragments = 1100000;
    const prompt =
      "Do not call tools. Reply only OK if this request is accepted. The following text is disposable padding.\n" +
      "x ".repeat(repeatedFragments);
    const bytes = Buffer.byteLength(prompt);
    assert.ok(bytes < 3 * 1024 * 1024);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        owner.session(sessionId).run(prompt),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("bounded overflow deadline")), 180000);
        }),
      ]);
      drain();
      await owner.close();
      closed = true;
      drain();
      const { header, events: persisted } = await readPersisted(
        join(dshHome, "sessions"),
        sessionId,
      );
      assert.equal(header.version, 4);
      assert.deepEqual(persisted, events);
      const user = events.find(
        (event) =>
          event.type === "user/message" &&
          event.data.content.some((block) => block.type === "text" && block.text === prompt),
      );
      assert.ok(user);
      const end = result.events.filter((event) => event.type === "turn/end").at(-1);
      assert.ok(end);
      const errorCode = end.data.reason.kind === "error" ? end.data.reason.error.code : undefined;
      const report = {
        dshVersion: "0.1.7-rc.2",
        sessionId,
        repeatedFragments,
        promptBytes: bytes,
        promptSha256: createHash("sha256").update(prompt).digest("hex"),
        advertisedContextWindow: 4000000,
        maxTokens: 16,
        statuses: proxy.evidence.messages.map((message) => message.status),
        terminalKind: end.data.reason.kind,
        errorCode,
        toolCalls: result.events.filter((event) => event.type === "tool/call").length,
        responseText: result.finalResponse,
        eventCount: events.length,
        fullEventsEqual: true,
        transport: proxy.evidence,
      };
      await writeFile(join(root, "result.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
      verifyRemoteOverflow(report);
      assert.equal(proxy.evidence.uploads.length, 0);
      await proxy.cleanup();
      console.log(JSON.stringify(report, null, 2));
      verified = true;
    } finally {
      clearTimeout(timer);
      sub.close();
    }
  } finally {
    try {
      if (owner && !closed) {
        await owner.close();
        closed = true;
      }
    } finally {
      let proxyClosed = !proxy;
      let transportSaved = !proxy;
      try {
        if (proxy) {
          await saveAndCloseTransport(join(root, "transport.json"), proxy.evidence, async () => {
            await proxy!.close();
            proxyClosed = true;
          });
          transportSaved = true;
        }
      } finally {
        let removed = false;
        try {
          if (verified && closed && proxyClosed && transportSaved) {
            await rm(root, { recursive: true, force: true });
            removed = true;
            console.log(JSON.stringify({ localTemporaryDirectoryRemoved: true }));
          }
        } finally {
          if (!removed)
            console.error(
              JSON.stringify({
                retainedDirectory: root,
                closed,
                proxyClosed,
                transportSaved,
                automaticReplay: false,
              }),
            );
        }
      }
    }
  }
}
await main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      failed: true,
      error: error instanceof Error ? error.name : "UnknownError",
      automaticReplay: false,
    }),
  );
  process.exitCode = 1;
});
