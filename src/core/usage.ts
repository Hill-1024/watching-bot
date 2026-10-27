import type { Usage } from "@earendil-works/pi-ai";
import type { Repo, TokenUsageRow } from "../store/db.js";

/** 一次模型调用在面板里的归类 */
export const USAGE_SOURCES = ["main", "compaction", "memory", "weekly", "judge"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const USAGE_SOURCE_LABELS: Record<UsageSource, string> = {
  main: "主对话",
  compaction: "上下文压缩",
  memory: "睡眠归并",
  weekly: "周记归并",
  judge: "情绪判读",
};

export interface NormalizedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  costTotal: number;
}

export function normalizeUsage(usage: Partial<Usage> | undefined | null): NormalizedUsage {
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const input = n(usage?.input);
  const output = n(usage?.output);
  const cacheRead = n(usage?.cacheRead);
  const cacheWrite = n(usage?.cacheWrite);
  const reasoning = n(usage?.reasoning);
  const reportedTotal = n(usage?.totalTokens);
  const sum = input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: reportedTotal > 0 ? reportedTotal : sum,
    costTotal: typeof usage?.cost?.total === "number" && Number.isFinite(usage.cost.total) ? usage.cost.total : 0,
  };
}

/** 缓存命中率的分母包含未缓存输入、缓存读取与缓存写入 */
export function cacheHitRate(cacheRead: number, input: number, cacheWrite: number): number {
  const denom = cacheRead + input + cacheWrite;
  return denom > 0 ? cacheRead / denom : 0;
}

export interface UsageMeta {
  provider?: string;
  model?: string;
  tsSim?: number;
  tsReal?: number;
}

/** 唯一写入口:主 agent、压缩、记忆、judge 都经由它落库 */
export class UsageRecorder {
  constructor(
    private readonly repo: Repo,
    private readonly clock: { simNow(): number },
    /** 记录成功后通知(面板 Token 页事件驱动刷新) */
    private readonly onRecord?: (source: UsageSource) => void,
  ) {}

  record(source: UsageSource, usage: Partial<Usage> | undefined | null, meta: UsageMeta = {}): void {
    const u = normalizeUsage(usage);
    if (u.total <= 0) return;
    this.repo.insertTokenUsage({
      tsReal: meta.tsReal ?? Date.now(),
      tsSim: meta.tsSim ?? this.clock.simNow(),
      source,
      provider: meta.provider ?? "",
      model: meta.model ?? "",
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      reasoning: u.reasoning,
      total: u.total,
      costTotal: u.costTotal,
    });
    this.onRecord?.(source);
  }
}

export interface UsageBucket {
  ts: number;
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
  cacheHitRate: number;
}

export interface UsageTotals {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  requests: number;
  cacheHitRate: number;
  costTotal: number;
}

export interface UsageGroup {
  key: string;
  label: string;
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  cacheHitRate: number;
}

export type UsageBucketUnit = "hour" | "day" | "week";

export interface UsageAggregate {
  bucketUnit: UsageBucketUnit;
  bucketMs: number;
  buckets: UsageBucket[];
  totals: UsageTotals;
  previous: UsageTotals;
  bySource: UsageGroup[];
  byModel: UsageGroup[];
}

export function emptyTotals(): UsageTotals {
  return {
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    requests: 0,
    cacheHitRate: 0,
    costTotal: 0,
  };
}

function addTotals(t: UsageTotals, row: TokenUsageRow): void {
  t.total += row.total;
  t.input += row.input;
  t.output += row.output;
  t.cacheRead += row.cacheRead;
  t.cacheWrite += row.cacheWrite;
  t.reasoning += row.reasoning;
  t.requests += 1;
  t.costTotal += row.costTotal;
}

function finishTotals(t: UsageTotals): UsageTotals {
  t.cacheHitRate = cacheHitRate(t.cacheRead, t.input, t.cacheWrite);
  return t;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function alignDown(ts: number, unit: UsageBucketUnit): number {
  const d = new Date(ts);
  if (unit === "hour") {
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  d.setHours(0, 0, 0, 0);
  if (unit === "week") {
    const mondayOffset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - mondayOffset);
  }
  return d.getTime();
}

/** 自动桶粒度 + 桶起点对齐本地时间 */
export function chooseBucket(
  since: number,
  until: number,
  requested: "auto" | UsageBucketUnit = "auto",
): { unit: UsageBucketUnit; bucketMs: number; start: number; count: number } {
  const span = Math.max(1, until - since);
  let unit: UsageBucketUnit;
  if (requested !== "auto") {
    unit = requested;
  } else if (span <= 2 * DAY_MS) {
    unit = "hour";
  } else if (span <= 183 * DAY_MS) {
    unit = "day";
  } else {
    unit = "week";
  }
  const bucketMs = unit === "hour" ? HOUR_MS : unit === "day" ? DAY_MS : 7 * DAY_MS;
  let start = alignDown(since, unit);
  // 自定义跨度极大时继续降级,保证折线点数有界
  while (Math.ceil((until - start) / bucketMs) > 420) {
    if (unit === "hour") {
      unit = "day";
      start = alignDown(since, unit);
    } else if (unit === "day") {
      unit = "week";
      start = alignDown(since, unit);
    } else {
      break;
    }
  }
  const finalMs = unit === "hour" ? HOUR_MS : unit === "day" ? DAY_MS : 7 * DAY_MS;
  return { unit, bucketMs: finalMs, start, count: Math.max(1, Math.ceil((until - start) / finalMs)) };
}

export function aggregateUsage(
  rows: TokenUsageRow[],
  since: number,
  until: number,
  requested: "auto" | UsageBucketUnit = "auto",
  previousRows: TokenUsageRow[] = [],
): UsageAggregate {
  const { unit, bucketMs, start, count } = chooseBucket(since, until, requested);
  const buckets: UsageBucket[] = Array.from({ length: count }, (_, i) => ({
    ts: start + i * bucketMs,
    total: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    requests: 0,
    cacheHitRate: 0,
  }));

  const totals = emptyTotals();
  const bySource = new Map<string, UsageGroup>();
  const byModel = new Map<string, UsageGroup>();

  for (const row of rows) {
    addTotals(totals, row);
    const idx = Math.floor((row.tsReal - start) / bucketMs);
    if (idx >= 0 && idx < count) {
      const b = buckets[idx]!;
      b.total += row.total;
      b.input += row.input;
      b.output += row.output;
      b.cacheRead += row.cacheRead;
      b.cacheWrite += row.cacheWrite;
      b.reasoning += row.reasoning;
      b.requests += 1;
    }
    const src = bySource.get(row.source) ?? {
      key: row.source,
      label: USAGE_SOURCE_LABELS[row.source as UsageSource] ?? row.source,
      total: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      requests: 0,
      cacheHitRate: 0,
    };
    src.total += row.total;
    src.input += row.input;
    src.output += row.output;
    src.cacheRead += row.cacheRead;
    src.cacheWrite += row.cacheWrite;
    src.requests += 1;
    bySource.set(row.source, src);

    const modelKey = row.model ? `${row.provider ? `${row.provider}/` : ""}${row.model}` : "(未知模型)";
    const model = byModel.get(modelKey) ?? {
      key: modelKey,
      label: modelKey,
      total: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      requests: 0,
      cacheHitRate: 0,
    };
    model.total += row.total;
    model.input += row.input;
    model.output += row.output;
    model.cacheRead += row.cacheRead;
    model.cacheWrite += row.cacheWrite;
    model.requests += 1;
    byModel.set(modelKey, model);
  }

  for (const b of buckets) b.cacheHitRate = cacheHitRate(b.cacheRead, b.input, b.cacheWrite);
  for (const g of bySource.values()) g.cacheHitRate = cacheHitRate(g.cacheRead, g.input, g.cacheWrite);
  for (const g of byModel.values()) g.cacheHitRate = cacheHitRate(g.cacheRead, g.input, g.cacheWrite);

  const previous = emptyTotals();
  for (const row of previousRows) addTotals(previous, row);
  finishTotals(previous);

  return {
    bucketUnit: unit,
    bucketMs,
    buckets,
    totals: finishTotals(totals),
    previous,
    bySource: [...bySource.values()].sort((a, b) => b.total - a.total),
    byModel: [...byModel.values()].sort((a, b) => b.total - a.total),
  };
}
