const chapters = {
  1: {
    title: "从一次阻塞式调用开始",
    description: "FastAPI 等待 DSH 完成整个活动区间，再返回最终结果。",
    transport: "HTTP JSON",
    button: "运行第一章示例",
    tutorial: "https://github.com/eriklee1895/hands-on-dsh/blob/main/tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/01-blocking-api.md",
  },
  2: {
    title: "把同步回调桥接成 SSE",
    description: "DSH 在工作线程执行，浏览器在同一 HTTP 响应中持续接收命名事件。",
    transport: "POST + SSE",
    button: "运行第二章事件示例",
    tutorial: "https://github.com/eriklee1895/hands-on-dsh/blob/main/tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/02-sse-stream.md",
  },
  3: {
    title: "让浏览器拥有连续会话",
    description: "在同一个存活的 runtime 中复用 session ID，让下一轮看到前文。",
    transport: "POST + SSE",
    button: "继续第三章会话",
    tutorial: "https://github.com/eriklee1895/hands-on-dsh/blob/main/tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/03-multi-turn-session.md",
  },
  4: {
    title: "把 Agent 轨迹变成产品事件",
    description: "文本、工具调用、工具结果和 subagent 生命周期分别渲染，不暴露推理内容。",
    transport: "Projected SSE",
    button: "运行第四章工具任务",
    tutorial: "https://github.com/eriklee1895/hands-on-dsh/blob/main/tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/04-tool-trajectory.md",
  },
  5: {
    title: "共享 Runtime，隔离 Session",
    description: "同一 session 串行、不同 session 并发；服务关闭前等待已接纳任务结算。",
    transport: "Managed Runtime",
    button: "运行第五章示例",
    tutorial: "https://github.com/eriklee1895/hands-on-dsh/blob/main/tutorials/fastapi-101/src/dsh_fastapi_101/static/tutorials/05-runtime-lifecycle.md",
  },
};

const pathMatch = window.location.pathname.match(/\/chapter\/([1-5])/);
const chapterId = Number(pathMatch?.[1] || 1);
const config = chapters[chapterId] || chapters[1];
const form = document.querySelector("#chat-form");
const promptInput = document.querySelector("#prompt");
const sessionInput = document.querySelector("#session-id");
const runButton = document.querySelector("#run-button");
const responseBox = document.querySelector("#response");
const timeline = document.querySelector("#timeline");
const eventCount = document.querySelector("#event-count");
const finishReason = document.querySelector("#finish-reason");
const requestStatus = document.querySelector("#request-status");
let eventsSeen = 0;

function newSessionId() {
  return `web-${crypto.randomUUID()}`;
}

function applyChapter() {
  document.querySelector("#chapter-kicker").textContent = `第 ${chapterId} 章`;
  document.querySelector("#chapter-title").textContent = config.title;
  document.querySelector("#chapter-description").textContent = config.description;
  document.querySelector("#transport-label").textContent = config.transport;
  document.querySelector("#tutorial-link").href = config.tutorial;
  runButton.textContent = config.button;
  document.querySelectorAll("[data-chapter]").forEach((link) => {
    link.classList.toggle("active", Number(link.dataset.chapter) === chapterId);
  });
  if (chapterId === 4) {
    promptInput.value = "使用 bash 执行 printf 'TOOL_EVENT_OK\\n'，然后只回复它的输出。";
  }
}

function setBusy(busy, label) {
  runButton.disabled = busy;
  document.querySelector("#new-session").disabled = busy;
  requestStatus.textContent = label;
}

function resetOutput() {
  responseBox.textContent = "";
  responseBox.removeAttribute("role");
  timeline.replaceChildren();
  eventsSeen = 0;
  eventCount.textContent = "0 events";
  finishReason.textContent = "运行中";
}

function addTimelineEvent(event) {
  eventsSeen += 1;
  eventCount.textContent = `${eventsSeen} events`;
  const item = document.createElement("li");
  item.className = event.type;
  const kind = document.createElement("span");
  kind.className = "timeline-kind";
  kind.textContent = event.type;
  const meta = document.createElement("span");
  meta.className = "timeline-meta";
  meta.textContent = `${event.session_id}\n${JSON.stringify(event.data, null, 2)}`;
  item.append(kind, meta);
  timeline.append(item);
  timeline.scrollTop = timeline.scrollHeight;
}

function handleEvent(event) {
  addTimelineEvent(event);
  if (event.type === "assistant_message") {
    responseBox.textContent = event.data.text || "";
  } else if (event.type === "final") {
    responseBox.textContent = event.data.response || "";
    finishReason.textContent = event.data.finish_reason || "完成";
  } else if (event.type === "error") {
    finishReason.textContent = "错误";
    responseBox.textContent = event.data.message || "运行失败";
    responseBox.setAttribute("role", "alert");
  }
}

async function runBlocking(payload) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "运行失败");
  responseBox.textContent = data.response;
  finishReason.textContent = data.finish_reason || "完成";
}

async function runStreaming(payload) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) throw new Error(await response.text());
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine) {
        const event = JSON.parse(dataLine.slice(6));
        handleEvent(event);
        if (event.type === "final" || event.type === "error") terminal = event;
      }
    }
    if (done) break;
  }
  if (!terminal) throw new Error("事件流在运行结束前中断");
  if (terminal.type === "error") throw new Error(terminal.data.message || "运行失败");
}

async function refreshSessions() {
  const container = document.querySelector("#session-list");
  try {
    const response = await fetch("/api/sessions");
    const { session_ids: ids } = await response.json();
    container.replaceChildren();
    if (!ids.length) {
      const empty = document.createElement("span");
      empty.textContent = "暂无 session";
      container.append(empty);
      return;
    }
    ids.forEach((id) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = id;
      button.addEventListener("click", () => { sessionInput.value = id; });
      container.append(button);
    });
  } catch {
    container.textContent = "无法读取 session 列表";
  }
}

async function checkHealth() {
  const dot = document.querySelector("#runtime-dot");
  const label = document.querySelector("#runtime-label");
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    if (!response.ok || !health.runtime_started) throw new Error("runtime unavailable");
    dot.className = "status-dot ready";
    label.textContent = "runtime 已就绪";
  } catch {
    dot.className = "status-dot error";
    label.textContent = "runtime 不可用";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  resetOutput();
  setBusy(true, "Agent 正在运行…");
  const payload = { prompt: promptInput.value, session_id: sessionInput.value };
  try {
    if (chapterId === 1) await runBlocking(payload);
    else await runStreaming(payload);
    requestStatus.textContent = "运行完成";
  } catch (error) {
    finishReason.textContent = "错误";
    responseBox.textContent = error instanceof Error ? error.message : String(error);
    responseBox.setAttribute("role", "alert");
    requestStatus.textContent = "运行失败";
  } finally {
    setBusy(false, requestStatus.textContent);
    await refreshSessions();
  }
});

document.querySelector("#new-session").addEventListener("click", () => {
  sessionInput.value = newSessionId();
  responseBox.textContent = "已切换到新 session。";
  finishReason.textContent = "尚未运行";
});
document.querySelector("#refresh-sessions").addEventListener("click", refreshSessions);
document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => { promptInput.value = button.dataset.prompt; promptInput.focus(); });
});

sessionInput.value = localStorage.getItem("dsh-fastapi-session") || newSessionId();
sessionInput.addEventListener("change", () => localStorage.setItem("dsh-fastapi-session", sessionInput.value));
applyChapter();
checkHealth();
refreshSessions();
