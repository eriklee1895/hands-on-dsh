# Python SDK demos

> Verified release (2026-09-28): `deepseek-harness-sdk==0.1.5rc1` and the matching `deepseek-harness-runtime-bin==0.1.5rc1`; upstream tag [`dsh-v0.1.5-rc.1`](https://github.com/deepseek-ai/deepseek-harness/tree/183f08e9c6dde7e36cd2318eaee70b0da08fb35e).

English | [中文](README.zh.md)

These examples progress from one high-level call to direct newline-delimited JSON-RPC. The SDK depends on the matching runtime wheel, which ships the public `dsh` CLI and profiles; running the examples needs no separate Node.js installation.

## Prerequisites

- Python 3.10 or newer on a supported platform
- A disposable workspace for examples that let the agent use local tools
- A root `.env` file with `DEEPSEEK_API_KEY`; add `DEEPSEEK_BASE_URL` when the model is served by a compatible proxy

Enter this project and synchronize its locked runtime and development tools. For local real-model runs, load the root `.env` explicitly; after this `cd`, `../../.env` is that file:

```sh
cd tutorials/python-sdk
uv sync --group dev
```

Keep credentials out of Git. When the variables are already exported in your shell, omit `--env-file ../../.env` from the same commands; do not put a real value in this README.

## Learning path

| Demo | API level | What it demonstrates | Tutorial |
|---|---|---|---|
| [`01_hello.py`](01_hello.py) | `DeepSeekHarness.run()` | One prompt, final response, session ID, and finish reason | [One high-level run](tutorials/01-hello.md) |
| [`02_reuse_session.py`](02_reuse_session.py) | `Session.run()` | One reused runtime process and two turns in the same session | [Reuse a runtime and session](tutorials/02-reuse-session.md) |
| [`03_stream_events.py`](03_stream_events.py) | High-level callback | Root committed `assistant/message` projection from notifications | [Observe committed messages](tutorials/03-stream-events.md) |
| [`04_workspace_agent.py`](04_workspace_agent.py) | High-level tools | A task that reads and writes files inside a selected workspace | [Run tools in a workspace](tutorials/04-workspace-agent.md) |
| [`05_low_level_client.py`](05_low_level_client.py) | `HarnessClient` | Initialization, prompt enqueue, durable inbox receipt, events, and idle settlement | [Drive `HarnessClient`](tutorials/05-low-level-client.md) |
| [`06_raw_jsonrpc.py`](06_raw_jsonrpc.py) | Raw stdio JSON-RPC | Process launch, JSONL framing, response correlation, notification consumption, and teardown | [Hand-write JSON-RPC](tutorials/06-raw-jsonrpc.md) |

Run the examples from the `tutorials/python-sdk` directory:

```sh
uv run --env-file ../../.env python 01_hello.py
uv run --env-file ../../.env python 02_reuse_session.py
uv run --env-file ../../.env python 03_stream_events.py
uv run --env-file ../../.env python 04_workspace_agent.py
uv run --env-file ../../.env python 05_low_level_client.py
uv run --env-file ../../.env python 06_raw_jsonrpc.py
```

Every script accepts `--help`. The first, third, fifth, and sixth scripts also accept a positional prompt.

The scripts select `sdk-minimal` except `04_workspace_agent.py`, which selects the full `sdk` profile for file tools. All accept `--profile`, repeatable `--patch`, `--workspace`, and `--dsh-home`. The default temporary workspace and home are removed only after the runtime closes successfully; a failed close retains them for inspection. The explicit home owns profiles and session data. A retained home and the same session ID are needed to investigate persistence across processes, which these examples do not claim to demonstrate.

## Quality checks

The `dev` dependency group supplies pytest and Ruff. Check behavior, lint, and formatting without installing global tools:

```sh
uv run pytest
uv run ruff check .
uv run ruff format --check .
```

Apply Ruff's formatter with `uv run ruff format .`. Update dependencies through uv so `pyproject.toml` and `uv.lock` remain synchronized.

## Streaming behavior

The Python SDK delivers notifications through `on_notification` during `Session.run()`. The example projects the text blocks of root-session `assistant/message` events after each message is committed. These notifications are not token-level model streaming. The callback can also receive known descendant sessions, so it filters by the root `sessionId`.

`Session.run()` is synchronous and returns when its receipt-to-idle activity interval settles. The SDK has no token iterator; `03_stream_events.py` prints each committed message as its event arrives, then compares it with `RunResult.final_response`.

## Choose an integration level

| Choice | Use it when | Caller responsibilities |
|---|---|---|
| `DeepSeekHarness` | The business needs prompts, final responses, notifications, and session reuse | Runtime context management and application-level task state |
| `HarnessClient` | The business needs direct notification subscriptions or prompt enqueue receipts | Activity-interval correlation and result projection |
| Raw JSON-RPC | Diagnosing the protocol, prototyping another SDK, or working around a client-only limitation | Process lifecycle, concurrent stdout/stderr draining, request correlation, notification routing, timeouts, protocol validation, and teardown |

Raw JSON-RPC cannot add a server method that the DSH JSON-RPC server does not implement. Prefer extending the server and wrapping the new method in `HarnessClient` over duplicating transport code in each application.

## Release verification (2026-09-28)

The installed distributions reported SDK `0.1.5rc1` and runtime `0.1.5rc1`. Using `uv run --env-file <path-to-env> python <script>` from this tutorial directory with `deepseek-official` / `deepseek-v4-flash`, all six examples exited 0. The release's official adapter uses the Chat Completions API and Session V3. This run had no `DEEPSEEK_BASE_URL` override; the credential is omitted here.

| Script | Observed result | Runtime descendants seen / alive after exit |
| --- | --- | --- |
| `01_hello.py` | `hello from dsh`; completed | 2 / 0 |
| `02_reuse_session.py` | `stored`, then `SAFFRON`; completed | 2 / 0 |
| `03_stream_events.py` | one committed message matched `final_response`; completed | 2 / 0 |
| `04_workspace_agent.py` | `output.txt` verified as exact bytes `b"blue\ngreen\nred\n"`; completed | 2 / 0 |
| `05_low_level_client.py` | root committed response `low level client ok` | 2 / 0 |
| `06_raw_jsonrpc.py` | root committed response `raw json rpc ok` | 2 / 0 |

The process counts came from an external `ps` parent/child walk while each command ran and a PID check after it exited. The generated replies are one model run, not a guarantee of future model wording. The byte comparison and process observation are independent of the model's description.

## Safety and result semantics

- The bundled runtime can expose local file and process tools. Point `cwd` at a disposable checkout or an otherwise isolated workspace.
- Each script creates a fresh temporary workspace and Harness home, closes the runtime, then removes those directories. Pass `--dsh-home` or `--workspace` only when you intentionally want to retain or inspect them; use separate paths for independent runs.
- A `session/prompt` response confirms that the message was enqueued; it is not the agent result. The low-level examples correlate its `messageId` with `agent/inbox/spliced`, then wait for `session.status=idle`.
- The final response and finish reason returned by `Session.run()` describe the owned activity interval. Other queued work may participate before the agent becomes idle.
- Independent business tasks should use distinct session IDs. Reuse a session ID only when the next turn should retain its conversation and runtime state.
