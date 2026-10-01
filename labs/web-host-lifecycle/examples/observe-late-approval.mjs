/** Correlate one live approval with later Web replies without retaining raw wire data. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

const [cdpUrl, webOrigin, labRoot] = process.argv.slice(2);
assert.ok(
  cdpUrl && webOrigin && labRoot,
  "Use: observe-late-approval.mjs CDP_URL WEB_ORIGIN LAB_ROOT",
);
const root = await realpath(labRoot);
const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
assert.equal(state.kind, "web-host-lab");
assert.equal(state.root, root);
const endpoint = new URL(cdpUrl);
const origin = new URL(webOrigin);
assert.equal(endpoint.hostname, "127.0.0.1");
assert.equal(origin.hostname, "127.0.0.1");
assert.equal(origin.protocol, "http:");
assert.ok(endpoint.protocol === "ws:" || endpoint.protocol === "http:");
endpoint.protocol = "http:";
endpoint.pathname = "/json/list";
endpoint.search = "";
endpoint.hash = "";
const targets = await (await fetch(endpoint)).json();
const page = targets.find(
  (target) => target.type === "page" && new URL(target.url).origin === origin.origin,
);
assert.ok(page, "Open the isolated Web page before observing");
const socket = new WebSocket(page.webSocketDebuggerUrl);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const auditPath = join(root, "late-wire-audit.json");
const evalPath = join(root, "late-answer-eval.js");
const captures = [];
const posts = [];
const byRequest = new Map();
const responseCommands = new Map();
let clientId;
let commandId = 100;
writeFileSync(auditPath, JSON.stringify({ captures, posts }), { mode: 0o600, flag: "wx" });

function saveAudit() {
  writeFileSync(auditPath, JSON.stringify({ captures, posts }, null, 2), { mode: 0o600 });
}

function makeEvalScript(rawClientId, rawEventId) {
  return `(async () => {
    if (document.querySelector('[data-approval-key]') !== null || !document.body.innerText.includes('已停止')) {
      throw new Error('Cancel the pending approval in the official UI and wait for 已停止 first');
    }
    const key = 'dsh.webRecovery.lateAnswerSent';
    if (sessionStorage.getItem(key) !== null) throw new Error('Stale answer already attempted');
    sessionStorage.setItem(key, 'attempted');
    const clientId = ${JSON.stringify(rawClientId)};
    const eventId = ${JSON.stringify(rawEventId)};
    const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    const deliver = async selectedEventId => {
      const rpcId = crypto.randomUUID();
      const response = await fetch('/api/$events/result', {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({type: 'client-request', rpcId, method: '$events/result',
          payload: {args: {clientId, eventId: selectedEventId,
            outcome: {kind: 'result', value: 'allowed-once'}}}})
      });
      const body = await response.json();
      return {clientIdHash: await digest(clientId), eventIdHash: await digest(selectedEventId),
        rpcIdHash: await digest(rpcId), http: response.status,
        rpcAccepted: body?.result?.ok === true, errorCode: body?.result?.error?.code ?? null};
    };
    const valid = await deliver(eventId);
    let wrongEventId = crypto.randomUUID();
    while (wrongEventId === eventId) wrongEventId = crypto.randomUUID();
    const negative = await deliver(wrongEventId);
    return {valid, negative};
  })()`;
}

function observeFrame(value, depth = 0) {
  if (depth > 10) return;
  if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
    try {
      observeFrame(JSON.parse(value), depth + 1);
    } catch {
      /* Non-JSON transport content carries no approval correlation. */
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) observeFrame(item, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (value.type === "ready" && typeof value.clientId === "string") clientId = value.clientId;
  if (
    value.type === "waterfall" &&
    value.event === "approval/request" &&
    typeof value.eventId === "string" &&
    typeof value.agentId === "string" &&
    value.request?.toolName === "bash" &&
    typeof value.request.callId === "string"
  ) {
    assert.ok(clientId, "approval frame arrived before its ready frame");
    captures.push({
      clientIdHash: digest(clientId),
      eventIdHash: digest(value.eventId),
      agentIdHash: digest(value.agentId),
      callIdHash: digest(value.request.callId),
      toolName: "bash",
    });
    saveAudit();
    if (captures.length === 1) {
      writeFileSync(evalPath, makeEvalScript(clientId, value.eventId), {
        mode: 0o600,
        flag: "wx",
      });
      console.log("Approval correlation captured; keep observing through the stale replies.");
    }
  }
  for (const child of Object.values(value)) observeFrame(child, depth + 1);
}

function observePost(params) {
  if (params.request.method !== "POST") return;
  if (new URL(params.request.url).pathname !== "/api/$events/result") return;
  const body = JSON.parse(params.request.postData ?? "null");
  const args = body?.payload?.args;
  if (
    body?.type !== "client-request" ||
    body.method !== "$events/result" ||
    typeof body.rpcId !== "string" ||
    typeof args?.clientId !== "string" ||
    typeof args.eventId !== "string" ||
    args.outcome?.kind !== "result" ||
    args.outcome.value !== "allowed-once"
  )
    return;
  const post = {
    clientIdHash: digest(args.clientId),
    eventIdHash: digest(args.eventId),
    rpcIdHash: digest(body.rpcId),
    outcome: "allowed-once",
    http: null,
    rpcAccepted: null,
  };
  posts.push(post);
  byRequest.set(params.requestId, post);
  saveAudit();
}

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
  console.log("Observer ready; reload the page before sending the approval prompt.");
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (responseCommands.has(message.id)) {
    const post = responseCommands.get(message.id);
    responseCommands.delete(message.id);
    if (typeof message.result?.body === "string") {
      const raw = message.result.base64Encoded
        ? Buffer.from(message.result.body, "base64").toString("utf8")
        : message.result.body;
      const response = JSON.parse(raw);
      post.rpcAccepted = response?.result?.ok === true;
      saveAudit();
    }
    return;
  }
  if (message.method === "Network.webSocketFrameReceived")
    observeFrame(message.params.response.payloadData);
  if (message.method === "Network.requestWillBeSent") observePost(message.params);
  if (message.method === "Network.responseReceived") {
    const post = byRequest.get(message.params.requestId);
    if (post) {
      post.http = message.params.response.status;
      saveAudit();
    }
  }
  if (message.method === "Network.loadingFinished") {
    const post = byRequest.get(message.params.requestId);
    if (post) {
      const id = commandId++;
      responseCommands.set(id, post);
      socket.send(
        JSON.stringify({
          id,
          method: "Network.getResponseBody",
          params: { requestId: message.params.requestId },
        }),
      );
    }
  }
});
socket.addEventListener("error", () => {
  console.error("CDP observer failed");
  process.exitCode = 1;
});
process.on("SIGINT", () => socket.close());
