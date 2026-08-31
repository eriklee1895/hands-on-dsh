import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import JsonlSessionPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { afterEach, expect, test, vi } from "vitest";
import { createResumeAwareContext } from "../src/server/sdk-resume-adapter.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function textResponse(text: string): StreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    ...Array.from(text, (char): StreamChunk => ({ type: "text-delta", index: 0, text: char })),
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "usage", usage: { inputTokens: 10, outputTokens: text.length } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = [];

  constructor(private readonly responses: StreamChunk[][]) {
    super();
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model });
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options);
    const response = this.responses.shift();
    if (response === undefined) throw new Error("scripted adapter exhausted");
    for (const chunk of response) yield chunk;
  }
}

async function mount(root: string, adapter: ScriptedAdapter): Promise<Context> {
  const ctx = new Context();
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(JsonlSessionPersistence, { root, compression: "none" });
  ctx.llm.registerAdapter(["mock"], adapter);
  return ctx;
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on("agent/status", ({ agent: subject, status }) => {
      if (subject !== agent || status !== "idle") return;
      dispose();
      resolve();
    });
  });
}

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: "text", text }],
    source: { kind: "user" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("adapter resumes one JSONL session across Context lifecycles and appends turn two", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "stage5-resume-jsonl-"));
  const workspace = await mkdtemp(join(tmpdir(), "stage5-resume-workspace-"));
  roots.push(storageRoot, workspace);
  const canonicalWorkspace = await realpath(workspace);
  const sessionId = SessionId("two-lifecycle-session");

  const firstAdapter = new ScriptedAdapter([textResponse("old answer")]);
  const first = await mount(storageRoot, firstAdapter);
  const firstFacade = createResumeAwareContext(first);
  const firstHandle = await firstFacade.agents.create({
    sessionId,
    meta: { cwd: canonicalWorkspace },
    agentOptions: { provider: "mock", model: "mock" },
  });
  const firstIdle = waitForIdle(first, firstHandle.agent);
  firstHandle.agent.followup(userMessage("old question"));
  await firstIdle;
  await first.sessions.flush(firstHandle.agent.session);
  const location = first.sessionPersistence.locate(firstHandle.agent.session.header);
  if (location === undefined) throw new Error("JSONL location is required");
  const firstBytes = await readFile(location.path, "utf8");
  expect(firstHandle.agent.session.deriveMessages()).toMatchObject([
    { role: "user" },
    { role: "assistant" },
  ]);
  await firstHandle.dispose();
  await first.fiber.dispose();

  const secondAdapter = new ScriptedAdapter([textResponse("new answer")]);
  const second = await mount(storageRoot, secondAdapter);
  const secondFacade = createResumeAwareContext(second);
  const secondHandle = await secondFacade.agents.create({
    sessionId,
    meta: { cwd: canonicalWorkspace },
    agentOptions: { provider: "mock", model: "mock" },
  });
  expect(secondHandle.agent.session.deriveMessages()).toMatchObject([
    { role: "user" },
    { role: "assistant" },
  ]);
  const secondIdle = waitForIdle(second, secondHandle.agent);
  secondHandle.agent.followup(userMessage("new question"));
  await secondIdle;
  await second.sessions.flush(secondHandle.agent.session);

  const messages = secondHandle.agent.session.deriveMessages();
  expect(messages).toHaveLength(4);
  expect(
    secondHandle.agent.session.events
      .filter((event) => event.type === "turn/start")
      .map((event) => (event.data as { turn: number }).turn),
  ).toEqual([1, 2]);
  expect(JSON.stringify(secondAdapter.requests[0]?.messages)).toContain("old question");
  expect(JSON.stringify(secondAdapter.requests[0]?.messages)).toContain("old answer");
  expect(JSON.stringify(secondAdapter.requests[0]?.messages)).toContain("new question");

  const secondBytes = await readFile(location.path, "utf8");
  expect(secondBytes.length).toBeGreaterThan(firstBytes.length);
  const records = secondBytes
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  const headers = records.filter(
    (record): record is Record<string, unknown> =>
      isRecord(record) &&
      record["id"] === sessionId &&
      record["version"] === 0 &&
      record["cwd"] === canonicalWorkspace,
  );
  expect(headers).toHaveLength(1);
  expect(
    (await second.sessionPersistence.list()).filter((item) => item.id === sessionId),
  ).toHaveLength(1);

  await secondHandle.dispose();
  await second.fiber.dispose();
});

test("a corrupt persisted log rejects resume without falling back to create", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "stage5-resume-corrupt-jsonl-"));
  const workspace = await mkdtemp(join(tmpdir(), "stage5-resume-corrupt-workspace-"));
  roots.push(storageRoot, workspace);
  const canonicalWorkspace = await realpath(workspace);
  const sessionId = SessionId("corrupt-lifecycle-session");

  const first = await mount(storageRoot, new ScriptedAdapter([textResponse("old answer")]));
  const firstHandle = await createResumeAwareContext(first).agents.create({
    sessionId,
    meta: { cwd: canonicalWorkspace },
    agentOptions: { provider: "mock", model: "mock" },
  });
  const idle = waitForIdle(first, firstHandle.agent);
  firstHandle.agent.followup(userMessage("old question"));
  await idle;
  await first.sessions.flush(firstHandle.agent.session);
  const location = first.sessionPersistence.locate(firstHandle.agent.session.header);
  if (location === undefined) throw new Error("JSONL location is required");
  await firstHandle.dispose();
  await first.fiber.dispose();
  const durable = await readFile(location.path, "utf8");
  const corrupted = durable.replace('"surfaceOp":"append"', '"surfaceOp":"invalid"');
  if (corrupted === durable) throw new Error("fixture has no committed surface event");
  await writeFile(location.path, corrupted);

  const second = await mount(storageRoot, new ScriptedAdapter([textResponse("unused")]));
  expect((await second.sessionPersistence.list()).map((item) => item.id)).toContain(sessionId);
  const create = vi.spyOn(second.agents, "create");
  let failure: unknown;
  try {
    await createResumeAwareContext(second).agents.create({
      sessionId,
      meta: { cwd: canonicalWorkspace },
      agentOptions: { provider: "mock", model: "mock" },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toMatch(/invalid|session|event|surface/i);
  expect(create.mock.calls).toHaveLength(0);
  expect(second.agents.get(sessionId)).toBeUndefined();
  await second.fiber.dispose();
});
