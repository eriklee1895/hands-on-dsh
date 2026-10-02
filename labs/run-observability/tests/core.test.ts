import { describe, expect, it } from "vitest";
import { ObservationLedger, type Binding, type Rates } from "../src/core.ts";

const binding: Binding = {
  sourceId: "source-1",
  runId: "run-1",
  sessionId: "session-1",
  provider: "deepseek-official",
  model: "deepseek-flash",
};
const rates: Rates = {
  rateId: "lesson-v1",
  provider: binding.provider,
  model: binding.model,
  inputNanoUsdPerToken: 2,
  outputNanoUsdPerToken: 3,
  cacheReadNanoUsdPerToken: 1,
  cacheWriteNanoUsdPerToken: 4,
};
const at = (seq: number, type: string, data: object = {}) => ({
  seq,
  time: 1_000 + seq,
  type,
  data,
});
const usage = (inputTokens: number, outputTokens: number, extra: object = {}) => ({
  inputTokens,
  outputTokens,
  ...extra,
});
const chunk = (value: object) => ({
  type: "chunk",
  time: 1_001,
  chunk: { type: "usage", usage: value },
});

describe("ObservationLedger", () => {
  it("projects only safe fields and treats discarded payload changes as a duplicate", () => {
    const ledger = new ObservationLedger();
    const raw = at(1, "tool/call", {
      turn: 1,
      step: 1,
      name: "SECRET_TOOL",
      callId: "SECRET_CALL",
      arguments: "SECRET_ARGS",
    });
    expect(ledger.ingest(binding, raw)).toBe(true);
    expect(
      ledger.ingest(binding, { ...raw, data: { ...raw.data, arguments: "OTHER_SECRET" } }),
    ).toBe(false);
    expect(ledger.ingest(binding, at(2, "secret/event", { prompt: "SECRET_PROMPT" }))).toBe(true);
    expect(
      ledger.ingest(binding, { seq: 3, time: 1003, type: "future/event", data: "SECRET_TEXT" }),
    ).toBe(true);
    const serialized = JSON.stringify(ledger.exportRecords());
    expect(serialized).not.toMatch(/SECRET|secret\/event/);
    expect(ledger.exportRecords().map((record) => record.kind)).toEqual([
      "tool/call",
      "other",
      "other",
    ]);
    const detached = ledger.exportRecords();
    detached[0]!.kind = "other";
    expect(ledger.exportRecords()[0]!.kind).toBe("tool/call");
  });

  it("counts settled attempts once, uses the final cumulative usage, and prices disjoint tokens", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(
      binding,
      at(1, "assistant/attempt", {
        turn: 1,
        step: 1,
        stream: [
          chunk(usage(2, 1)),
          chunk(usage(4, 2, { cacheReadTokens: 3, cacheWriteTokens: 1, reasoningTokens: 1 })),
        ],
        error: "SECRET_ERROR",
      }),
    );
    ledger.ingest(
      binding,
      at(2, "llm/retry", { turn: 1, step: 1, retry: 1, delayMs: 250, failure: "SECRET_FAILURE" }),
    );
    ledger.ingest(binding, at(3, "llm/retry-started", { turn: 1, step: 1, retry: 1 }));
    const reported = usage(5, 6, {
      cacheReadTokens: 7,
      cacheWriteTokens: 2,
      reasoningTokens: 4,
      totalTokens: 20,
    });
    ledger.ingest(
      binding,
      at(4, "assistant/message", {
        turn: 1,
        step: 2,
        message: {
          source: { provider: binding.provider, model: binding.model },
          content: "SECRET_TEXT",
        },
        stream: [chunk(reported)],
        usage: reported,
      }),
    );
    ledger.ingest(binding, at(5, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    const summary = ledger.summary(binding.runId, rates);
    expect(summary.observedAttempts).toBe(2);
    expect(summary.missingUsage).toBe(0);
    expect(summary.retryScheduled).toBe(1);
    expect(summary.retryStarted).toBe(1);
    expect(summary.totals).toEqual({
      inputTokens: "9",
      outputTokens: "8",
      cacheReadTokens: "10",
      cacheWriteTokens: "3",
      reasoningTokens: "5",
    });
    expect(summary.knownUsageEstimateNanoUsd).toBe("64");
    expect(summary.turnEnds).toEqual([{ seq: 5, turn: 1, outcome: "completed" }]);
    expect(summary.isInvoice).toBe(false);
    expect(summary.observedOnly).toBe(true);
    expect(JSON.stringify(summary)).not.toMatch(/SECRET/);
  });

  it("uses embedded message usage if scalar is absent and rejects contradictory scalar/stream usage", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(
      binding,
      at(1, "assistant/message", {
        turn: 1,
        step: 1,
        message: {},
        stream: [chunk(usage(1, 1)), chunk(usage(3, 2))],
      }),
    );
    expect(ledger.summary(binding.runId, rates).totals.inputTokens).toBe("3");
    expect(() =>
      ledger.ingest(
        binding,
        at(2, "assistant/message", {
          turn: 1,
          step: 2,
          message: {},
          usage: usage(5, 5),
          stream: [chunk(usage(4, 5))],
        }),
      ),
    ).toThrow();
  });

  it("accepts omitted optional stream buckets but rejects conflicting reported buckets", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(
      binding,
      at(1, "assistant/message", {
        turn: 1,
        step: 1,
        message: {},
        usage: usage(3, 2, { cacheReadTokens: 4 }),
        stream: [chunk(usage(3, 2))],
      }),
    );
    expect(ledger.summary(binding.runId, rates).totals.cacheReadTokens).toBe("4");
    expect(() =>
      ledger.ingest(
        binding,
        at(2, "assistant/message", {
          turn: 1,
          step: 2,
          message: {},
          usage: usage(3, 2, { cacheReadTokens: 5 }),
          stream: [chunk(usage(3, 2, { cacheReadTokens: 4 }))],
        }),
      ),
    ).toThrow();
  });

  it("requires an array stream and never reads scalar usage from an uncommitted attempt", () => {
    const ledger = new ObservationLedger();
    expect(() =>
      ledger.ingest(
        binding,
        at(1, "assistant/attempt", {
          turn: 1,
          step: 1,
          stream: [],
          usage: usage(100, 100),
        }),
      ),
    ).toThrow();
    expect(() =>
      ledger.ingest(
        binding,
        at(1, "assistant/message", {
          turn: 1,
          step: 1,
          message: {},
          stream: { type: "usage", usage: usage(1, 1) },
        }),
      ),
    ).toThrow();
    expect(ledger.exportRecords()).toEqual([]);
  });

  it("refuses inconsistent reported total tokens and scalar/stream total conflicts", () => {
    const ledger = new ObservationLedger();
    expect(() =>
      ledger.ingest(
        binding,
        at(1, "assistant/message", {
          turn: 1,
          step: 1,
          message: {},
          stream: [],
          usage: usage(3, 2, { totalTokens: 4 }),
        }),
      ),
    ).toThrow();
    expect(() =>
      ledger.ingest(
        binding,
        at(1, "assistant/message", {
          turn: 1,
          step: 1,
          message: {},
          stream: [],
          usage: usage(3, 2, { cacheReadTokens: 4, totalTokens: 8 }),
        }),
      ),
    ).toThrow();
    expect(() =>
      ledger.ingest(
        binding,
        at(1, "assistant/message", {
          turn: 1,
          step: 1,
          message: {},
          stream: [],
          usage: usage(3, 2, { cacheReadTokens: 4, cacheWriteTokens: 1, totalTokens: 11 }),
        }),
      ),
    ).toThrow();
    expect(() =>
      ledger.ingest(
        binding,
        at(1, "assistant/message", {
          turn: 1,
          step: 1,
          message: {},
          usage: usage(3, 2, { totalTokens: 9 }),
          stream: [chunk(usage(3, 2, { totalTokens: 10 }))],
        }),
      ),
    ).toThrow();
  });

  it("keeps missing usage unknown and reports absent optional buckets", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(binding, at(1, "assistant/attempt", { turn: 1, step: 1, stream: [] }));
    ledger.ingest(
      binding,
      at(2, "assistant/message", { turn: 1, step: 2, message: {}, stream: [], usage: usage(2, 3) }),
    );
    const summary = ledger.summary(binding.runId, rates);
    expect(summary.missingUsage).toBe(1);
    expect(summary.missingOptional).toEqual({
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
      reasoningTokens: 1,
    });
    expect(summary.totals).toEqual({
      inputTokens: "2",
      outputTokens: "3",
      cacheReadTokens: "0",
      cacheWriteTokens: "0",
      reasoningTokens: "0",
    });
    expect(summary.knownUsageEstimateNanoUsd).toBe("13");
  });

  it("rejects invalid usage and route mismatches without changing its records", () => {
    const ledger = new ObservationLedger();
    const bad = [
      usage(-1, 1),
      usage(1.5, 1),
      usage(Number.MAX_SAFE_INTEGER + 1, 1),
      usage(1, 1, { cacheReadTokens: -1 }),
      usage(1, 1, { reasoningTokens: 2 }),
      { inputTokens: 1 },
    ];
    for (const value of bad)
      expect(() =>
        ledger.ingest(
          binding,
          at(1, "assistant/message", { turn: 1, step: 1, message: {}, stream: [], usage: value }),
        ),
      ).toThrow();
    expect(() =>
      ledger.ingest(
        binding,
        at(1, "request/header", {
          header: { config: { provider: "other", model: binding.model } },
        }),
      ),
    ).toThrow();
    expect(() =>
      ledger.ingest(
        binding,
        at(1, "assistant/message", {
          turn: 1,
          step: 1,
          message: { source: { provider: binding.provider, model: "other" } },
          stream: [],
        }),
      ),
    ).toThrow();
    expect(ledger.exportRecords()).toEqual([]);
  });

  it("rejects sequence conflicts and overlapping run intervals but accepts two disjoint runs", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(binding, at(1, "turn/start", { turn: 1 }));
    expect(() =>
      ledger.ingest(binding, at(1, "turn/end", { turn: 1, reason: { kind: "completed" } })),
    ).toThrow();
    expect(() =>
      ledger.ingest({ ...binding, runId: "run-2" }, at(1, "turn/start", { turn: 1 })),
    ).toThrow();
    const second = { ...binding, runId: "run-2" };
    ledger.ingest(second, at(3, "turn/start", { turn: 2 }));
    expect(() => ledger.ingest(binding, at(4, "step/start", { turn: 1, step: 1 }))).toThrow();
    expect(
      ledger.ingest(second, at(4, "turn/end", { turn: 2, reason: { kind: "completed" } })),
    ).toBe(true);
    expect(ledger.summary(second.runId, rates).turnEnds).toHaveLength(1);
  });

  it("rehydrates strict detached records and rejects privacy-bearing fields", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(
      binding,
      at(2, "assistant/message", { turn: 1, step: 1, message: {}, stream: [], usage: usage(1, 1) }),
    );
    ledger.ingest(binding, at(1, "turn/start", { turn: 1 }));
    const records = ledger.exportRecords();
    const restored = ObservationLedger.fromRecords(records);
    expect(restored.summary(binding.runId, rates)).toEqual(ledger.summary(binding.runId, rates));
    expect(() => ObservationLedger.fromRecords([{ ...records[0], prompt: "SECRET" }])).toThrow();
    expect(() =>
      ObservationLedger.fromRecords([
        { ...records[0], usage: { ...records[0]!.usage, extra: "SECRET" } },
      ]),
    ).toThrow();
    expect(() => ObservationLedger.fromRecords([{ ...records[0], seq: NaN }])).toThrow();
    expect(() =>
      ObservationLedger.fromRecords([{ ...records[0], kind: "secret/event" }]),
    ).toThrow();
  });

  it("handles large safe-integer counts with bigint accumulation and rejects unmatched rates", () => {
    const ledger = new ObservationLedger();
    const huge = Number.MAX_SAFE_INTEGER;
    ledger.ingest(
      binding,
      at(1, "assistant/message", {
        turn: 1,
        step: 1,
        message: {},
        stream: [],
        usage: usage(huge, huge),
      }),
    );
    ledger.ingest(
      binding,
      at(2, "assistant/message", {
        turn: 1,
        step: 2,
        message: {},
        stream: [],
        usage: usage(huge, huge),
      }),
    );
    expect(ledger.summary(binding.runId, rates).totals.inputTokens).toBe(
      (BigInt(huge) * 2n).toString(),
    );
    expect(ledger.summary(binding.runId, rates).knownUsageEstimateNanoUsd).toBe(
      (BigInt(huge) * 10n).toString(),
    );
    expect(() => ledger.summary(binding.runId, { ...rates, model: "other" })).toThrow();
  });

  it("marks auxiliary calls as excluded and does not count them as attempts", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(
      binding,
      at(1, "compaction/summary", { summary: "SECRET_SUMMARY", usage: usage(10, 10) }),
    );
    ledger.ingest(
      binding,
      at(2, "session/title-llm-request", { prompt: "SECRET_TITLE", usage: usage(20, 20) }),
    );
    const summary = ledger.summary(binding.runId, rates);
    expect(summary.auxiliaryExcluded).toEqual({ compactionSummaries: 1, titleLlmRequests: 1 });
    expect(summary.observedAttempts).toBe(0);
    expect(summary.knownUsageEstimateNanoUsd).toBe("0");
    expect(JSON.stringify(summary)).not.toMatch(/SECRET/);
  });

  it("retains only a finite finish label from raw stream failures", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(
      binding,
      at(1, "assistant/attempt", {
        turn: 1,
        step: 1,
        stream: [
          {
            type: "chunk",
            time: 1001,
            chunk: {
              type: "finish",
              reason: { kind: "error", failure: { message: "SECRET_ERROR" } },
            },
          },
        ],
      }),
    );
    expect(ledger.exportRecords()[0]).toMatchObject({ kind: "assistant/attempt", finish: "error" });
    expect(JSON.stringify(ledger.exportRecords())).not.toMatch(/SECRET/);
  });

  it("refuses impossible persisted outcomes and extra fields on known kinds", () => {
    const ledger = new ObservationLedger();
    ledger.ingest(binding, at(1, "turn/end", { turn: 1, reason: { kind: "completed" } }));
    const record = ledger.exportRecords()[0]!;
    expect(() => ObservationLedger.fromRecords([{ ...record, outcome: "committed" }])).toThrow();
    expect(() => ObservationLedger.fromRecords([{ ...record, retry: 1 }])).toThrow();
  });
});
