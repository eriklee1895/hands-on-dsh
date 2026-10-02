/** Keyless library probes against the sibling lab's locked published packages. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const lab = createRequire(new URL("../../labs/runtime-supervision/package.json", import.meta.url));
const sdk = createRequire(lab.resolve("@deepseek-ai/dsh-sdk-client/package.json"));
const cli = createRequire(sdk.resolve("@deepseek-ai/dsh/package.json"));
const bundle = createRequire(cli.resolve("@deepseek-ai/dsh-sdk-minimal/package.json"));
const version = "0.1.7-rc.2";

async function load(name) {
  const manifest = JSON.parse(readFileSync(bundle.resolve(`${name}/package.json`), "utf8"));
  assert.equal(manifest.version, name === "@deepseek-ai/cordis" ? "4.0.4" : version);
  return import(pathToFileURL(bundle.resolve(name)).href);
}

const { Context } = await load("@deepseek-ai/cordis");
const {
  default: Llm,
  LlmAdapter,
  createUserMessage,
  expandAssistantStream,
} = await load("@deepseek-ai/dsh-llm");
const { default: Sessions, SessionId } = await load("@deepseek-ai/dsh-session");
const { default: Projections } = await load("@deepseek-ai/dsh-session-projection");
const { default: Prompt } = await load("@deepseek-ai/dsh-system-prompt");
const { default: Tools } = await load("@deepseek-ai/dsh-tools");
const { default: Agents } = await load("@deepseek-ai/dsh-agent");
const { default: Loop } = await load("@deepseek-ai/dsh-agent-loop");

function textChunks(text) {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text },
    { type: "block-end", index: 0, block: { type: "text", text } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

/** The only adapter: returns fixture chunks without reading env or opening a socket. */
class FixtureAdapter extends LlmAdapter {
  requests = [];
  constructor(script) {
    super();
    this.script = script;
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model };
  }
  async *stream(request) {
    this.requests.push(request);
    const chunks = this.script.shift();
    assert.ok(chunks, "unexpected extra model request");
    yield* chunks;
  }
}

async function fixture(t, responses) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  for (const plugin of [Llm, Sessions, Projections, Prompt, Tools, Agents])
    await ctx.plugin(plugin);
  await ctx.plugin(Loop, { agents: [] });
  const adapter = new FixtureAdapter(responses);
  ctx.effect(() => ctx.llm.registerAdapter(["fixture"], adapter));
  const handle = await ctx.agents.create({
    sessionId: SessionId(`notes-${t.name.replaceAll(" ", "-")}`),
    agentOptions: { provider: "fixture", model: "fixture" },
  });
  t.after(() => handle.dispose());
  return { ctx, adapter, agent: handle.agent };
}

function message(text) {
  return createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
}

// snapshotEvents is a deprecated synchronous reader permitted for diagnostic tests.
test("inbox waits for waking input and commits embedded stream", async (t) => {
  const { ctx, adapter, agent } = await fixture(t, [textChunks("fixture answer")]);
  const frames = [];
  ctx.on("agent/assistant-stream", ({ frame }) => frames.push(frame));
  agent.inject(message("parked context"));
  assert.equal(agent.status, "idle");
  assert.equal(adapter.requests.length, 0);
  assert.equal(agent.session.snapshotEvents().filter((e) => e.type === "turn/start").length, 0);
  agent.followup(message("wake now"));
  assert.equal(agent.status, "running");
  await agent.whenIdle();
  const events = agent.session.snapshotEvents();
  const assistant = events.find((e) => e.type === "assistant/message");
  assert.equal(agent.session.header.version, 4);
  assert.equal(
    events.some((e) => e.type === "assistant/chunk"),
    false,
  );
  assert.equal(assistant.data.message.content[0].text, "fixture answer");
  assert.equal(
    expandAssistantStream(assistant.data.stream).filter((c) => c.chunk.type === "text-delta")
      .length,
    1,
  );
  assert.equal(frames[0].type, "start");
  assert.equal(frames.at(-1).type, "end");
  const requested = JSON.stringify(adapter.requests[0].messages);
  const parked = requested.indexOf("parked context");
  const waking = requested.indexOf("wake now");
  assert.notEqual(parked, -1, "injected context must reach the model request");
  assert.notEqual(waking, -1, "waking input must reach the model request");
  assert.ok(parked < waking);
  assert.equal(adapter.requests[0].messages[0].role, "system");
  assert.ok(events.some((e) => e.type === "system/message"));
});

test("missing tool produces V4 message and continues next step", async (t) => {
  const block = {
    type: "tool-call",
    id: "notes-call",
    name: "unregistered_fixture_tool",
    arguments: "{}",
  };
  const chunks = [
    { type: "block-start", index: 0, blockType: "tool-call" },
    { type: "tool-call-delta", index: 0, id: block.id, name: block.name, argumentsDelta: "{}" },
    { type: "block-end", index: 0, block },
    { type: "finish", reason: { kind: "tool-calls" } },
  ];
  const { adapter, agent } = await fixture(t, [chunks, textChunks("error observed")]);
  agent.followup(message("exercise unknown tool"));
  await agent.whenIdle();
  const events = agent.session.snapshotEvents();
  const result = events.find((e) => e.type === "tool/result");
  assert.equal(result.data.message.toolCallId, block.id);
  assert.equal(result.data.message.isError, true);
  assert.equal("result" in result.data, false);
  assert.equal(result.sourceEventSeqs[0], events.find((e) => e.type === "tool/call").seq);
  assert.equal(adapter.requests.length, 2);
  assert.ok(
    adapter.requests[1].messages.some((m) => m.role === "tool" && m.toolCallId === block.id),
  );
  assert.equal(events.filter((e) => e.type === "step/start").length, 2);
});

test("runtime context snapshots deduplicate and log changes", async (t) => {
  const { ctx, agent } = await fixture(t, [
    textChunks("one"),
    textChunks("two"),
    textChunks("three"),
  ]);
  let value = "context alpha";
  ctx.systemPrompt.context({ name: "notes-context", order: 100, text: () => value });
  for (const input of ["first", "same"]) {
    agent.followup(message(input));
    await agent.whenIdle();
  }
  const contexts = () =>
    agent.session
      .snapshotEvents()
      .filter((e) => e.type === "user/message" && e.data.source.kind === "runtime-context");
  assert.equal(contexts().length, 1);
  value = "context beta";
  agent.followup(message("changed"));
  await agent.whenIdle();
  assert.equal(contexts().length, 2);
  assert.ok(JSON.stringify(contexts().at(-1)).includes("context beta"));
});
