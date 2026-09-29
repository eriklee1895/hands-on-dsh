/** Fictional observations and prices; none are provider billing records. */
import type { Binding, Rates } from "../src/core.ts";

export const RATES: Rates = {
  rateId: "teaching-v1-not-provider-prices",
  provider: "deepseek-official",
  model: "deepseek-flash",
  inputNanoUsdPerToken: 1000,
  outputNanoUsdPerToken: 2000,
  cacheReadNanoUsdPerToken: 100,
  cacheWriteNanoUsdPerToken: 1200,
};
export const SENTINEL = "PRIVATE_PAYLOAD_MUST_NOT_BE_EXPORTED";
const base = {
  sourceId: "store-demo",
  sessionId: "session-demo",
  provider: RATES.provider,
  model: RATES.model,
};
export const RUN_A: Binding = { ...base, runId: "run-a" };
export const RUN_B: Binding = { ...base, runId: "run-b" };
const first = {
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 5,
  cacheWriteTokens: 0,
  reasoningTokens: 1,
  totalTokens: 17,
};
const second = {
  inputTokens: 20,
  outputTokens: 4,
  cacheReadTokens: 8,
  cacheWriteTokens: 0,
  reasoningTokens: 2,
  totalTokens: 32,
};
const chunk = (usage: object) => ({ type: "chunk", time: 1020, chunk: { type: "usage", usage } });
const event = (seq: number, type: string, data: object) => ({
  seq,
  type,
  time: 1000 + seq * 10,
  data,
});
export const EVENTS_A = [
  event(0, "turn/start", { turn: 1 }),
  event(1, "user/message", { content: SENTINEL }),
  event(2, "request/header", {
    turn: 1,
    step: 1,
    header: { config: { provider: RATES.provider, model: RATES.model }, system: SENTINEL },
  }),
  event(3, "step/start", { turn: 1, step: 1 }),
  event(4, "assistant/attempt", {
    turn: 1,
    step: 1,
    stream: [
      chunk({ inputTokens: 2, outputTokens: 1 }),
      chunk(first),
      {
        type: "chunk",
        time: 1040,
        chunk: { type: "finish", reason: { kind: "error", failure: { message: SENTINEL } } },
      },
    ],
  }),
  event(5, "llm/retry", {
    turn: 1,
    step: 1,
    retryId: "retry-demo",
    provider: RATES.provider,
    mode: "normal",
    policyKey: "demo",
    retry: 1,
    maxRetries: 1,
    delayMs: 50,
    failure: { message: SENTINEL },
  }),
  event(6, "llm/retry-started", { turn: 1, step: 1, retryId: "retry-demo", retry: 1 }),
  event(7, "assistant/message", {
    turn: 1,
    step: 1,
    usage: second,
    stream: [chunk(second)],
    message: {
      source: { provider: RATES.provider, model: RATES.model },
      content: [{ type: "text", text: SENTINEL }],
    },
  }),
  event(8, "step/end", { turn: 1, step: 1 }),
  event(9, "compaction/summary", {
    usage: { inputTokens: 999, outputTokens: 999 },
    rawOutput: SENTINEL,
  }),
  event(10, "turn/end", { turn: 1, reason: { kind: "completed" } }),
];
export const EVENTS_B = [
  event(11, "turn/start", { turn: 2 }),
  event(12, "step/start", { turn: 2, step: 1 }),
  event(13, "assistant/attempt", {
    turn: 2,
    step: 1,
    stream: [
      {
        type: "chunk",
        time: 1130,
        chunk: { type: "finish", reason: { kind: "error", failure: { message: SENTINEL } } },
      },
    ],
  }),
  event(14, "turn/end", { turn: 2, reason: { kind: "error", error: SENTINEL } }),
];
