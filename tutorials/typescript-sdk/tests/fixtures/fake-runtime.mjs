import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_DSH_MODE ?? "normal";
const state = process.env.FAKE_DSH_STATE ?? process.cwd();
const requests = `${state}/requests.jsonl`;
const memory = new Map();
const sequences = new Map();
const turns = new Map();

writeFileSync(`${state}/pid`, String(process.pid));

function frame(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function notify(method, params) {
  frame({ jsonrpc: "2.0", method, params });
}

function response(id, result) {
  frame({ jsonrpc: "2.0", id, result });
}

function error(id, code, message) {
  frame({ jsonrpc: "2.0", id, error: { code, message } });
}

function event(sessionId, type, data) {
  const seq = sequences.get(sessionId) ?? 0;
  sequences.set(sessionId, seq + 1);
  notify("session.event", { sessionId, event: { type, seq, time: 0, data } });
  return seq;
}

function surfaceEvent(sessionId, type, data, sourceEventSeqs) {
  const seq = sequences.get(sessionId) ?? 0;
  sequences.set(sessionId, seq + 1);
  notify("session.event", {
    sessionId,
    event: { type, seq, time: 0, surfaceOp: "append", sourceEventSeqs, data },
  });
  return seq;
}

function assistantStep(
  sessionId,
  turn,
  step,
  text,
  content = [{ type: "text", text }],
  extraChunks = [],
) {
  const chunks = [{ type: "text-delta", index: 0, text }, ...extraChunks];
  const chunkSeqs = chunks.map((chunk) =>
    event(sessionId, "assistant/chunk", { turn, step, chunk }),
  );
  surfaceEvent(
    sessionId,
    "assistant/message",
    {
      turn,
      step,
      message: {
        id: `fake-assistant-${sessionId}-${turn}-${step}`,
        role: "assistant",
        content,
        source: { kind: "model", provider: "fake", model: "fake" },
      },
    },
    chunkSeqs,
  );
}

function scriptedUser(id, text) {
  return { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

function beginTurn(sessionId, userMessage, insertFirst) {
  if (insertFirst) {
    event(sessionId, "agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      inserted: [userMessage],
    });
  }
  const turn = (turns.get(sessionId) ?? 0) + 1;
  turns.set(sessionId, turn);
  event(sessionId, "turn/start", { turn });
  event(sessionId, "agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    removedCount: 1,
    inserted: [],
  });
  event(sessionId, "step/start", { turn, step: 1 });
  surfaceEvent(sessionId, "user/message", userMessage);
  return turn;
}

function assistantTurn(sessionId, text, userMessage, insertFirst = false) {
  const turn = beginTurn(sessionId, userMessage, insertFirst);
  assistantStep(sessionId, turn, 1, text);
  event(sessionId, "step/end", { turn, step: 1 });
  event(sessionId, "turn/end", { turn, reason: { kind: "completed" } });
}

function toolTurn(sessionId, path, encoded, userMessage) {
  const turn = beginTurn(sessionId, userMessage, false);
  const callId = "fake-write-file-call";
  const args = JSON.stringify({ path, contentBase64: encoded });
  assistantStep(
    sessionId,
    turn,
    1,
    "writing proof",
    [
      { type: "text", text: "writing proof" },
      { type: "tool-call", id: callId, name: "write-file", arguments: args },
    ],
    [{ type: "tool-call-delta", index: 1, id: callId, name: "write-file", argumentsDelta: args }],
  );
  const callSeq = event(sessionId, "tool/call", {
    turn,
    step: 1,
    callId,
    name: "write-file",
    arguments: args,
  });
  writeFileSync(path, Buffer.from(encoded, "base64"));
  surfaceEvent(
    sessionId,
    "tool/result",
    {
      turn,
      step: 1,
      message: {
        id: `fake-tool-result-${sessionId}-${turn}-1`,
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: callId,
            content: [{ type: "text", text: "wrote proof file" }],
            isError: false,
          },
        ],
        source: { kind: "tool", callId },
      },
    },
    [callSeq],
  );
  event(sessionId, "step/end", { turn, step: 1 });
  event(sessionId, "step/start", { turn, step: 2 });
  assistantStep(sessionId, turn, 2, "proof created");
  event(sessionId, "step/end", { turn, step: 2 });
  event(sessionId, "turn/end", { turn, reason: { kind: "completed" } });
}

function promptText(params) {
  return params.contentBlocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function finishPrompt(id, params) {
  const sessionId = params.sessionId;
  const input = promptText(params);
  const messageId = `message-${id}`;
  const queuedUser = {
    id: messageId,
    role: "user",
    content: params.contentBlocks,
    source: { kind: "user" },
  };

  if (mode === "noisy") {
    assistantTurn("foreign", "foreign root", scriptedUser("foreign-pre", "foreign prompt"), true);
    assistantTurn(
      sessionId,
      "pre receipt root",
      scriptedUser(`${sessionId}-pre`, "pre receipt prompt"),
      true,
    );
    notify("session.status", { sessionId, status: "idle" });
    notify("subagent.started", {
      parentSessionId: sessionId,
      childSessionId: `${sessionId}-child`,
    });
    assistantTurn(
      `${sessionId}-child`,
      "descendant answer",
      scriptedUser(`${sessionId}-child-pre`, "child pre prompt"),
      true,
    );
    notify("subagent.finished", {
      provider: "fake",
      agentId: `${sessionId}-child`,
      parentSessionId: sessionId,
      childSessionId: `${sessionId}-child`,
      status: "ok",
      stopReason: "completed",
      lastAssistantMessage: [{ type: "text", text: "descendant answer" }],
    });
  }
  event(sessionId, "agent/inbox/spliced", {
    target: "next-turn",
    start: 0,
    inserted: [queuedUser],
  });
  setImmediate(() => {
    response(id, { messageId });
    notify("session.status", { sessionId, status: "running" });
    let answer = "ok";
    if (mode === "noisy") {
      assistantTurn(
        "foreign",
        "post receipt foreign",
        scriptedUser("foreign-post", "foreign post prompt"),
        true,
      );
      assistantTurn(
        `${sessionId}-child`,
        "post receipt child",
        scriptedUser(`${sessionId}-child-post`, "child post prompt"),
        true,
      );
      answer = "post receipt root";
    } else if (input.startsWith("Remember ")) {
      const remembered = input.slice("Remember ".length).replace(/\.$/, "").toLowerCase();
      memory.set(sessionId, remembered);
      answer = `remembered: ${remembered}`;
    } else if (input.includes("What did I ask you to remember?")) {
      answer = `memory: ${memory.get(sessionId) ?? "nothing"}`;
    } else if (input.startsWith("WRITE_FILE:")) {
      const [, path, encoded] = input.split(":");
      toolTurn(sessionId, path, encoded, queuedUser);
      notify("session.status", { sessionId, status: "idle" });
      return;
    } else if (input.startsWith("使用可用工具创建文件 ")) {
      const match = /^使用可用工具创建文件 (.+?)，内容必须/.exec(input);
      if (match === null) throw new Error("fake proof prompt did not contain a path");
      const encoded = Buffer.from("hands-on-dsh TypeScript SDK proof\n", "utf8").toString("base64");
      toolTurn(sessionId, match[1], encoded, queuedUser);
      notify("session.status", { sessionId, status: "idle" });
      return;
    }
    assistantTurn(sessionId, answer, queuedUser);
    notify("session.status", { sessionId, status: "idle" });
  });
}

async function handle(request) {
  appendFileSync(requests, `${JSON.stringify(request)}\n`);
  if (mode === "forced") return;
  if (request.method === "initialize") {
    response(request.id, {
      serverInfo: { name: "deepseek-harness-sdk-runtime", version: "0.0.1" },
    });
    return;
  }
  if (request.method === "session/prompt") {
    if (mode === "error") {
      error(request.id, -32603, "fake internal error");
      return;
    }
    if (mode === "malformed") {
      response(request.id, { accepted: true });
      return;
    }
    if (mode === "eof") {
      process.exit(7);
      return;
    }
    if (mode === "timeout") return;
    finishPrompt(request.id, request.params);
    return;
  }
  if (request.method === "shutdown") {
    response(request.id, {});
    setImmediate(() => process.exit(0));
    return;
  }
  error(request.id, -32601, "method not found");
}

if (mode === "forced") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const request = JSON.parse(line);
  void handle(request);
});
