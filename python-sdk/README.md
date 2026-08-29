# Python SDK demos

English | [中文](README.zh.md)

These examples progress from one high-level call to direct newline-delimited JSON-RPC. They use the runtime bundled with `deepseek-harness-sdk`, so an installed release does not need Node.js or a separately installed `dsh` executable.

## Prerequisites

- Python 3.10 or newer on a supported platform
- A disposable workspace for examples that let the agent use local tools
- `DEEPSEEK_API_KEY` in the environment
- `DEEPSEEK_BASE_URL` when the model is served by a compatible proxy

Create an environment and install the SDK:

```sh
python -m venv .venv
. .venv/bin/activate
python -m pip install deepseek-harness-sdk
export DEEPSEEK_API_KEY=sk-your-key-here
# export DEEPSEEK_BASE_URL=http://127.0.0.1:8000/v1
# export DSH_MODEL=deepseek-v4-flash
```

## Learning path

| Demo | API level | What it demonstrates | Tutorial |
|---|---|---|---|
| [`01_hello.py`](01_hello.py) | `DeepSeekHarness.run()` | One prompt, final response, session ID, and finish reason | [One high-level run](tutorials/01-hello.md) |
| [`02_reuse_session.py`](02_reuse_session.py) | `Session.run()` | One reused runtime process and two turns in the same session | [Reuse a runtime and session](tutorials/02-reuse-session.md) |
| [`03_stream_events.py`](03_stream_events.py) | High-level callback | Live committed text projected from `assistant/chunk` notifications | [Stream committed text](tutorials/03-stream-events.md) |
| [`04_workspace_agent.py`](04_workspace_agent.py) | High-level tools | A task that reads and writes files inside a selected workspace | [Run tools in a workspace](tutorials/04-workspace-agent.md) |
| [`05_low_level_client.py`](05_low_level_client.py) | `HarnessClient` | Initialization, prompt enqueue, durable inbox receipt, events, and idle settlement | [Drive `HarnessClient`](tutorials/05-low-level-client.md) |
| [`06_raw_jsonrpc.py`](06_raw_jsonrpc.py) | Raw stdio JSON-RPC | Process launch, JSONL framing, response correlation, notification consumption, and teardown | [Hand-write JSON-RPC](tutorials/06-raw-jsonrpc.md) |

Run the examples from the repository root:

```sh
python python-sdk/01_hello.py
python python-sdk/02_reuse_session.py
python python-sdk/03_stream_events.py
python python-sdk/04_workspace_agent.py
python python-sdk/05_low_level_client.py
python python-sdk/06_raw_jsonrpc.py
```

Every script accepts `--help`. The first, third, fifth, and sixth scripts also accept a positional prompt.

## Streaming behavior

The Python SDK supports notification streaming through `on_notification`. During `Session.run()`, the callback receives `session.event` notifications containing `assistant/chunk` events. A committed text increment is at `event.data.chunk` when its type is `text-delta`; reasoning deltas and tool-call deltas are separate chunk types. The callback can also receive notifications from known descendant sessions, so the example filters text by the root `sessionId`.

`Session.run()` remains a synchronous call and returns only when its owned activity interval reaches the next whole-agent `idle` state. The SDK does not currently expose a dedicated iterator such as `for chunk in stream`; `03_stream_events.py` shows the small projection needed for terminal, SSE, or WebSocket output.

## Choose an integration level

| Choice | Use it when | Caller responsibilities |
|---|---|---|
| `DeepSeekHarness` | The business needs prompts, final responses, notifications, and session reuse | Runtime context management and application-level task state |
| `HarnessClient` | The business needs direct notification subscriptions or prompt enqueue receipts | Activity-interval correlation and result projection |
| Raw JSON-RPC | Diagnosing the protocol, prototyping another SDK, or working around a client-only limitation | Process lifecycle, concurrent stdout/stderr draining, request correlation, notification routing, timeouts, protocol validation, and teardown |

Raw JSON-RPC cannot add a server method that the DSH JSON-RPC server does not implement. Prefer extending the server and wrapping the new method in `HarnessClient` over duplicating transport code in each application.

## Safety and result semantics

- The bundled runtime can expose local file and process tools. Point `cwd` at a disposable checkout or an otherwise isolated workspace.
- Unless overridden with `--session-root`, the examples keep durable logs under `.dsh-python-demo-sessions` in the current directory.
- A `session/prompt` response confirms that the message was enqueued; it is not the agent result. The low-level examples correlate its `messageId` with `agent/inbox/spliced`, then wait for `session.status=idle`.
- The final response and finish reason returned by `Session.run()` describe the owned activity interval. Other queued work may participate before the agent becomes idle.
- Independent business tasks should use distinct session IDs. Reuse a session ID only when the next turn should retain its conversation and runtime state.
