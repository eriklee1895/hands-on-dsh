/** Stable server-owned identity for one observed business run. */
export interface Binding {
  sourceId: string;
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
}

/** Explicit teaching prices in integer nano-USD per reported token. */
export interface Rates {
  rateId: string;
  provider: string;
  model: string;
  inputNanoUsdPerToken: number;
  outputNanoUsdPerToken: number;
  cacheReadNanoUsdPerToken: number;
  cacheWriteNanoUsdPerToken: number;
}

/** Sanitized provider-reported counters for one settled attempt. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/** A finite event label; unknown raw event names become `other`. */
export type ObservationKind =
  | "turn/start"
  | "turn/end"
  | "step/start"
  | "step/end"
  | "request/header"
  | "assistant/message"
  | "assistant/attempt"
  | "llm/retry"
  | "llm/retry-started"
  | "compaction/summary"
  | "session/title-llm-request"
  | "user/message"
  | "tool/call"
  | "tool/result"
  | "other";

export type Outcome =
  | "completed"
  | "aborted"
  | "blocked"
  | "error"
  | "max-tokens"
  | "interrupted"
  | "forked"
  | "other"
  | "committed"
  | "uncommitted";
export type Finish = "stop" | "tool-calls" | "max-tokens" | "aborted" | "error" | "other";

/** Schema-1 allowlist record. It never contains model or tool payloads. */
export interface Observation extends Binding {
  schema: 1;
  seq: number;
  time: number;
  kind: ObservationKind;
  turn?: number;
  step?: number;
  outcome?: Outcome;
  finish?: Finish;
  retry?: number;
  delayMs?: number;
  usage?: Usage | null;
}

export interface ObservationSummary {
  runId: string;
  sourceId: string;
  sessionId: string;
  provider: string;
  model: string;
  rateId: string;
  timeline: Observation[];
  turnEnds: { seq: number; turn: number; outcome: Outcome }[];
  observedAttempts: number;
  missingUsage: number;
  totals: {
    inputTokens: string;
    outputTokens: string;
    cacheReadTokens: string;
    cacheWriteTokens: string;
    reasoningTokens: string;
  };
  missingOptional: { cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number };
  retryScheduled: number;
  retryStarted: number;
  auxiliaryExcluded: { compactionSummaries: number; titleLlmRequests: number };
  clockRegressed: boolean;
  knownUsageEstimateNanoUsd: string;
  isInvoice: false;
  observedOnly: true;
}

const kinds: readonly ObservationKind[] = [
  "turn/start",
  "turn/end",
  "step/start",
  "step/end",
  "request/header",
  "assistant/message",
  "assistant/attempt",
  "llm/retry",
  "llm/retry-started",
  "compaction/summary",
  "session/title-llm-request",
  "user/message",
  "tool/call",
  "tool/result",
  "other",
];
const outcomes: readonly Outcome[] = [
  "completed",
  "aborted",
  "blocked",
  "error",
  "max-tokens",
  "interrupted",
  "forked",
  "other",
  "committed",
  "uncommitted",
];
const finishes: readonly Finish[] = [
  "stop",
  "tool-calls",
  "max-tokens",
  "aborted",
  "error",
  "other",
];
const bindingFields = ["sourceId", "runId", "sessionId", "provider", "model"] as const;
const optionalFields = ["turn", "step", "outcome", "finish", "retry", "delayMs", "usage"] as const;
const usageFields = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid observation input");
  return value as Record<string, unknown>;
}

function natural(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid observation number");
  return value;
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    throw new Error("Invalid observation identifier");
  }
  return value;
}

function bindingOf(value: unknown): Binding {
  const source = object(value);
  return {
    sourceId: identifier(source.sourceId),
    runId: identifier(source.runId),
    sessionId: identifier(source.sessionId),
    provider: identifier(source.provider),
    model: identifier(source.model),
  };
}

function usageOf(value: unknown, strict: boolean): Usage {
  const raw = object(value);
  if (
    strict &&
    Object.keys(raw).some((key) => !usageFields.includes(key as (typeof usageFields)[number]))
  )
    throw new Error("Invalid observation usage");
  const usage: Usage = {
    inputTokens: natural(raw.inputTokens),
    outputTokens: natural(raw.outputTokens),
  };
  for (const key of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
    if (raw[key] !== undefined) usage[key] = natural(raw[key]);
  }
  if (raw.totalTokens !== undefined) usage.totalTokens = natural(raw.totalTokens);
  if (usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.outputTokens)
    throw new Error("Invalid reasoning usage");
  if (usage.totalTokens !== undefined) {
    const reportedMinimum =
      BigInt(usage.inputTokens) +
      BigInt(usage.outputTokens) +
      BigInt(usage.cacheReadTokens ?? 0) +
      BigInt(usage.cacheWriteTokens ?? 0);
    const reportedTotal = BigInt(usage.totalTokens);
    if (
      reportedTotal < reportedMinimum ||
      (usage.cacheReadTokens !== undefined &&
        usage.cacheWriteTokens !== undefined &&
        reportedTotal !== reportedMinimum)
    )
      throw new Error("Inconsistent total usage");
  }
  return usage;
}

function streamUsage(value: unknown): Usage | undefined {
  if (!Array.isArray(value)) throw new Error("Invalid assistant stream");
  let last: Usage | undefined;
  for (const item of value) {
    const record = object(item);
    if (record.type !== "chunk") continue;
    const chunk = object(record.chunk);
    if (chunk.type === "usage") last = usageOf(chunk.usage, false);
  }
  return last;
}

function streamFinish(value: unknown): Finish | undefined {
  if (!Array.isArray(value)) return undefined;
  let last: Finish | undefined;
  for (const item of value) {
    const record = object(item);
    if (record.type !== "chunk") continue;
    const chunk = object(record.chunk);
    if (chunk.type !== "finish") continue;
    const reason = typeof chunk.reason === "string" ? chunk.reason : object(chunk.reason).kind;
    last =
      typeof reason === "string" && finishes.includes(reason as Finish)
        ? (reason as Finish)
        : "other";
  }
  return last;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compatibleUsage(left: Usage, right: Usage): boolean {
  return usageFields.every(
    (key) => left[key] === undefined || right[key] === undefined || left[key] === right[key],
  );
}

function project(binding: Binding, value: unknown): Observation {
  const event = object(value);
  const kind: ObservationKind =
    typeof event.type === "string" && kinds.includes(event.type as ObservationKind)
      ? (event.type as ObservationKind)
      : "other";
  const data = kind === "other" ? {} : object(event.data);
  const record: Observation = {
    schema: 1,
    ...binding,
    seq: natural(event.seq),
    time: natural(event.time),
    kind,
  };
  if (
    [
      "turn/start",
      "turn/end",
      "step/start",
      "step/end",
      "assistant/message",
      "assistant/attempt",
      "llm/retry",
      "llm/retry-started",
      "tool/call",
      "tool/result",
    ].includes(kind)
  ) {
    record.turn = natural(data.turn);
  }
  if (
    [
      "step/start",
      "step/end",
      "assistant/message",
      "assistant/attempt",
      "llm/retry",
      "llm/retry-started",
      "tool/call",
      "tool/result",
    ].includes(kind)
  ) {
    record.step = natural(data.step);
  }
  if (kind === "turn/end") {
    const reason = object(data.reason);
    record.outcome =
      typeof reason.kind === "string" &&
      outcomes.includes(reason.kind as Outcome) &&
      reason.kind !== "committed" &&
      reason.kind !== "uncommitted"
        ? (reason.kind as Outcome)
        : "other";
  }
  if (kind === "llm/retry" || kind === "llm/retry-started") {
    record.retry = natural(data.retry);
    if (kind === "llm/retry") record.delayMs = natural(data.delayMs);
  }
  if (kind === "request/header") {
    const config = object(object(data.header).config);
    if (config.provider !== binding.provider || config.model !== binding.model)
      throw new Error("Observed route differs from run binding");
  }
  if (kind === "assistant/message") {
    const message = object(data.message);
    if (message.source !== undefined) {
      const source = object(message.source);
      if (source.provider !== binding.provider || source.model !== binding.model)
        throw new Error("Observed route differs from run binding");
    }
    record.outcome = data.interrupted === true ? "interrupted" : "committed";
  }
  if (kind === "assistant/attempt") record.outcome = "uncommitted";
  if (kind === "assistant/message" || kind === "assistant/attempt") {
    if (kind === "assistant/attempt" && data.usage !== undefined)
      throw new Error("Unexpected scalar attempt usage");
    record.finish = streamFinish(data.stream);
    if (record.finish === undefined) delete record.finish;
    const embedded = streamUsage(data.stream);
    const top =
      kind === "assistant/message" && data.usage !== undefined
        ? usageOf(data.usage, false)
        : undefined;
    if (top !== undefined && embedded !== undefined && !compatibleUsage(top, embedded))
      throw new Error("Contradictory usage reports");
    record.usage = top ?? embedded ?? null;
  }
  return record;
}

function validateRecord(value: unknown): Observation {
  const raw = object(value);
  const allowed = new Set<string>([
    "schema",
    ...bindingFields,
    "seq",
    "time",
    "kind",
    ...optionalFields,
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key)) || raw.schema !== 1)
    throw new Error("Invalid observation record");
  const binding = bindingOf(raw);
  if (typeof raw.kind !== "string" || !kinds.includes(raw.kind as ObservationKind))
    throw new Error("Invalid observation kind");
  const kind = raw.kind as ObservationKind;
  const record: Observation = {
    schema: 1,
    ...binding,
    seq: natural(raw.seq),
    time: natural(raw.time),
    kind,
  };
  if (raw.turn !== undefined) record.turn = natural(raw.turn);
  if (raw.step !== undefined) record.step = natural(raw.step);
  if (raw.outcome !== undefined) {
    if (typeof raw.outcome !== "string" || !outcomes.includes(raw.outcome as Outcome))
      throw new Error("Invalid observation outcome");
    record.outcome = raw.outcome as Outcome;
  }
  if (raw.finish !== undefined) {
    if (typeof raw.finish !== "string" || !finishes.includes(raw.finish as Finish))
      throw new Error("Invalid observation finish");
    record.finish = raw.finish as Finish;
  }
  if (raw.retry !== undefined) record.retry = natural(raw.retry);
  if (raw.delayMs !== undefined) record.delayMs = natural(raw.delayMs);
  if ("usage" in raw) record.usage = raw.usage === null ? null : usageOf(raw.usage, true);
  const needsTurn = [
    "turn/start",
    "turn/end",
    "step/start",
    "step/end",
    "assistant/message",
    "assistant/attempt",
    "llm/retry",
    "llm/retry-started",
    "tool/call",
    "tool/result",
  ].includes(kind);
  const needsStep = [
    "step/start",
    "step/end",
    "assistant/message",
    "assistant/attempt",
    "llm/retry",
    "llm/retry-started",
    "tool/call",
    "tool/result",
  ].includes(kind);
  const settles = kind === "assistant/message" || kind === "assistant/attempt";
  if (
    needsTurn !== (record.turn !== undefined) ||
    needsStep !== (record.step !== undefined) ||
    settles !== "usage" in record ||
    (kind === "turn/end" && record.outcome === undefined) ||
    (kind === "turn/end" && ["committed", "uncommitted"].includes(record.outcome ?? "")) ||
    (kind === "assistant/message" &&
      !["committed", "interrupted"].includes(record.outcome ?? "")) ||
    (kind === "assistant/attempt" && record.outcome !== "uncommitted") ||
    (kind !== "turn/end" && !settles && record.outcome !== undefined) ||
    (!settles && record.finish !== undefined) ||
    (kind === "llm/retry" || kind === "llm/retry-started") !== (record.retry !== undefined) ||
    (kind === "llm/retry") !== (record.delayMs !== undefined)
  )
    throw new Error("Invalid observation fields");
  return record;
}

/** In-memory, privacy-reduced replay ledger for one or more business runs. */
export class ObservationLedger {
  private readonly records = new Map<string, Observation>();
  private readonly runs = new Map<string, Binding>();

  /** Projects an event and returns false only for an identical sanitized duplicate. */
  ingest(binding: Binding, event: unknown): boolean {
    return this.add(project(bindingOf(binding), event));
  }

  private add(record: Observation): boolean {
    const key = JSON.stringify([record.sourceId, record.sessionId, record.seq]);
    const old = this.records.get(key);
    if (old !== undefined) {
      if (same(old, record)) return false;
      throw new Error("Conflicting observation sequence");
    }
    const binding = bindingOf(record);
    const prior = this.runs.get(record.runId);
    if (prior !== undefined && !same(prior, binding)) throw new Error("Conflicting run binding");
    for (const [runId, other] of this.runs) {
      if (
        runId === record.runId ||
        other.sourceId !== record.sourceId ||
        other.sessionId !== record.sessionId
      )
        continue;
      const seqs = [...this.records.values()]
        .filter((item) => item.runId === runId)
        .map((item) => item.seq);
      const own = [...this.records.values()]
        .filter((item) => item.runId === record.runId)
        .map((item) => item.seq);
      const min = Math.min(record.seq, ...own);
      const max = Math.max(record.seq, ...own);
      if (min <= Math.max(...seqs) && Math.min(...seqs) <= max)
        throw new Error("Overlapping run intervals");
    }
    this.runs.set(record.runId, binding);
    this.records.set(key, record);
    return true;
  }

  /** Returns detached normalized records in stable identity and sequence order. */
  exportRecords(): Observation[] {
    return [...this.records.values()]
      .sort(
        (a, b) =>
          a.sourceId.localeCompare(b.sourceId) ||
          a.sessionId.localeCompare(b.sessionId) ||
          a.seq - b.seq,
      )
      .map((record) => structuredClone(record));
  }

  /** Revalidates persisted records against the exact schema-1 allowlist. */
  static fromRecords(value: unknown): ObservationLedger {
    if (!Array.isArray(value)) throw new Error("Invalid observation records");
    const ledger = new ObservationLedger();
    for (const item of value) ledger.add(validateRecord(item));
    return ledger;
  }

  /** Summarizes observed settlements using an explicit matching teaching rate. */
  summary(runId: string, rates: Rates): ObservationSummary {
    identifier(runId);
    const binding = this.runs.get(runId);
    if (binding === undefined) throw new Error("Unknown run");
    const rateId = identifier(rates.rateId);
    if (rates.provider !== binding.provider || rates.model !== binding.model)
      throw new Error("Rate route mismatch");
    const prices = {
      inputTokens: natural(rates.inputNanoUsdPerToken),
      outputTokens: natural(rates.outputNanoUsdPerToken),
      cacheReadTokens: natural(rates.cacheReadNanoUsdPerToken),
      cacheWriteTokens: natural(rates.cacheWriteNanoUsdPerToken),
    };
    const timeline = this.exportRecords()
      .filter((record) => record.runId === runId)
      .sort((a, b) => a.seq - b.seq);
    const totals = {
      inputTokens: 0n,
      outputTokens: 0n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
      reasoningTokens: 0n,
    };
    const missingOptional = { cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const auxiliaryExcluded = { compactionSummaries: 0, titleLlmRequests: 0 };
    const turnEnds: ObservationSummary["turnEnds"] = [];
    let observedAttempts = 0;
    let missingUsage = 0;
    let retryScheduled = 0;
    let retryStarted = 0;
    let clockRegressed = false;
    let lastTime = -1;
    for (const record of timeline) {
      if (record.time < lastTime) clockRegressed = true;
      lastTime = record.time;
      if (record.kind === "turn/end")
        turnEnds.push({ seq: record.seq, turn: record.turn!, outcome: record.outcome! });
      if (record.kind === "llm/retry") retryScheduled++;
      if (record.kind === "llm/retry-started") retryStarted++;
      if (record.kind === "compaction/summary") auxiliaryExcluded.compactionSummaries++;
      if (record.kind === "session/title-llm-request") auxiliaryExcluded.titleLlmRequests++;
      if (record.kind !== "assistant/message" && record.kind !== "assistant/attempt") continue;
      observedAttempts++;
      if (record.usage === null || record.usage === undefined) {
        missingUsage++;
        continue;
      }
      totals.inputTokens += BigInt(record.usage.inputTokens);
      totals.outputTokens += BigInt(record.usage.outputTokens);
      for (const key of ["cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const) {
        if (record.usage[key] === undefined) missingOptional[key]++;
        else totals[key] += BigInt(record.usage[key]);
      }
    }
    const estimated =
      totals.inputTokens * BigInt(prices.inputTokens) +
      totals.outputTokens * BigInt(prices.outputTokens) +
      totals.cacheReadTokens * BigInt(prices.cacheReadTokens) +
      totals.cacheWriteTokens * BigInt(prices.cacheWriteTokens);
    return {
      ...binding,
      rateId,
      timeline,
      turnEnds,
      observedAttempts,
      missingUsage,
      totals: Object.fromEntries(
        Object.entries(totals).map(([key, value]) => [key, value.toString()]),
      ) as ObservationSummary["totals"],
      missingOptional,
      retryScheduled,
      retryStarted,
      auxiliaryExcluded,
      clockRegressed,
      knownUsageEstimateNanoUsd: estimated.toString(),
      isInvoice: false,
      observedOnly: true,
    };
  }
}
