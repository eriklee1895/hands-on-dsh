/** Observe CDP frame categories only; never retain payload text, cookies, or headers. */
import assert from "node:assert/strict";
import { appendFileSync, writeFileSync } from "node:fs";
const [cdpUrl, webOrigin, output] = process.argv.slice(2);
assert.ok(
  cdpUrl && webOrigin && output,
  "Use: browser-metadata.mjs CDP_URL WEB_ORIGIN OUTPUT_JSONL",
);
const endpoint = new URL(cdpUrl);
const origin = new URL(webOrigin);
assert.equal(endpoint.hostname, "127.0.0.1");
assert.equal(origin.hostname, "127.0.0.1");
assert.ok(endpoint.protocol === "ws:" || endpoint.protocol === "http:");
assert.equal(origin.protocol, "http:");
endpoint.protocol = "http:";
endpoint.pathname = "/json/list";
endpoint.search = "";
endpoint.hash = "";
const targets = await (await fetch(endpoint)).json();
const page = targets.find(
  (target) => target.type === "page" && new URL(target.url).origin === origin.origin,
);
assert.ok(page, "Open the experiment page first");
const socket = new WebSocket(page.webSocketDebuggerUrl);
writeFileSync(output, "", { mode: 0o600, flag: "wx" });
function record(value) {
  appendFileSync(output, JSON.stringify({ at: Date.now(), ...value }) + "\n");
}
const allowed = new Set([
  "item",
  "assistant-stream",
  "chunk",
  "text-delta",
  "event",
  "assistant/message",
  "turn/end",
  "completed",
  "baseline",
  "snapshot",
]);
function tags(value, result = new Set()) {
  if (Array.isArray(value)) for (const child of value) tags(child, result);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if ((key === "type" || key === "kind") && allowed.has(child)) result.add(child);
      else if (typeof child === "object") tags(child, result);
    }
  return [...result];
}
socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
  console.log("Observer ready; reload the page before sending a prompt.");
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  const params = message.params;
  if (message.method === "Network.webSocketCreated")
    record({ event: "socket", path: new URL(params.url).pathname });
  if (message.method === "Network.requestWillBeSent" && params.request.method === "POST")
    record({ event: "post", path: new URL(params.request.url).pathname });
  if (message.method === "Network.webSocketFrameReceived") {
    let categories = [];
    try {
      categories = tags(JSON.parse(params.response.payloadData));
    } catch {
      /* Binary/non-JSON frames have only opcode and byte-length evidence. */
    }
    record({
      event: "frame",
      opcode: params.response.opcode,
      payloadCodeUnits: params.response.payloadData.length,
      tags: categories,
    });
  }
});
socket.addEventListener("error", () => {
  console.error("CDP observer failed");
  process.exitCode = 1;
});
process.on("SIGINT", () => socket.close());
