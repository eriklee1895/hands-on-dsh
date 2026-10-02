# Tutorial 06: Hand-write stdio JSON-RPC

English | [中文](06-raw-jsonrpc.zh.md)

## Outcome

Use [`06_raw_jsonrpc.py`](../06_raw_jsonrpc.py) to launch the bundled runtime without `DeepSeekHarness` or `HarnessClient`. This is a protocol probe and SDK-authoring example, not the recommended application integration.

## Prerequisites

Complete [Tutorial 05](05-low-level-client.md). The installed `deepseek-harness-runtime-bin` package must contain a runtime for the current platform.

## Run it

```sh
uv run python 06_raw_jsonrpc.py \
  --session-id python-demo-06 \
  --dsh-home /tmp/dsh-demo-06 \
  "Reply with exactly: PYTHON_DEMO_06_OK"
```

The script prints the prompt message ID and final root committed response, then exits after a successful shutdown response.

## How it works

The script resolves the published runtime carrier and launches its public `dsh --profile sdk-minimal` entry, spawns the process with piped stdio, drains stdout and stderr concurrently, encodes one compact JSON-RPC object per line, correlates responses by ID, consumes notifications, and enforces the same durable-receipt-to-idle interval as the SDK.

```mermaid
flowchart TD
    Spawn[Spawn runtime] --> Readers[Start stdout and stderr readers]
    Readers --> Init[Send initialize id 1]
    Init --> Prompt[Send session/prompt id 2]
    Prompt --> Receipt[Correlate messageId and inbox receipt]
    Receipt --> Events[Consume session events]
    Events --> Idle{Root session idle?}
    Idle -->|No| Events
    Idle -->|Yes| Shutdown[Send shutdown id 3]
    Shutdown --> Reap[Close stdin and reap process]
```

Compare this file with [`client.py`](https://github.com/deepseek-ai/deepseek-harness/blob/183f08e9c6dde7e36cd2318eaee70b0da08fb35e/python/sdk/src/deepseek_harness/client.py): the SDK additionally owns concurrent request waiters, filtered subscriptions, descendant discovery, diagnostics, timeout behavior, transport closure errors, and reusable lifecycle management.

## Verify it

Confirm the prompt ID and committed response, a clean shutdown, and no runtime descendants after exit. A total activity deadline and EOF error prevent indefinite waiting; stderr is drained without echoing possible credentials.

## Limitations

Raw transport bypasses client validation and duplicates difficult lifecycle code. It cannot invoke methods absent from the server. Use it for diagnostics, conformance tests, or implementing a new language SDK; use `DeepSeekHarness` or `HarnessClient` in ordinary business code. The next learning layer is the FastAPI demo, which turns SDK notifications into browser-safe SSE events.
