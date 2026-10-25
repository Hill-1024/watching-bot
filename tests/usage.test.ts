import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  cacheHitRate,
  chooseBucket,
  normalizeUsage,
  type UsageBucketUnit,
} from "../src/core/usage.js";
import type { TokenUsageRow } from "../src/store/db.js";

const DAY = 86_400_000;

function row(tsReal: number, patch: Partial<TokenUsageRow> = {}): TokenUsageRow {
  const input = patch.input ?? 100;
  const output = patch.output ?? 40;
  const cacheRead = patch.cacheRead ?? 50;
  const cacheWrite = patch.cacheWrite ?? 0;
  return {
    tsReal,
    tsSim: tsReal,
    source: "main",
    provider: "test",
    model: "m",
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: 0,
    total: patch.total ?? input + output + cacheRead + cacheWrite,
    costTotal: 0,
    ...patch,
  };
}

describe("usage normalize", () => {
  it("缺失字段按 0 处理,空 usage 不产生记录", () => {
    expect(normalizeUsage(undefined).total).toBe(0);
    expect(normalizeUsage({ input: 10, output: 5 }).total).toBe(15);
  });

  it("保留 pi 上报的 total,并归一化负数", () => {
    const u = normalizeUsage({ input: 10, output: 5, totalTokens: 99, cacheRead: -3 });
    expect(u.total).toBe(99);
    expect(u.cacheRead).toBe(0);
  });

  it("缓存命中率分母含未缓存输入与缓存写入", () => {
    expect(cacheHitRate(50, 100, 50)).toBeCloseTo(0.25, 6);
    expect(cacheHitRate(0, 0, 0)).toBe(0);
  });
});

describe("usage bucket", () => {
  it("短区间自动按小时,并对齐到整点", () => {
    const since = new Date(2026, 9, 25, 10, 37, 12).getTime();
    const r = chooseBucket(since, since + 6 * 3_600_000);
    expect(r.unit).toBe("hour");
    const d = new Date(r.start);
    expect([d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0]);
  });

  it("多天区间按天,并对齐到本地零点", () => {
    const since = new Date(2026, 9, 20, 10, 0).getTime();
    const until = new Date(2026, 9, 25, 10, 0).getTime();
    const r = chooseBucket(since, until);
    expect(r.unit).toBe("day");
    const d = new Date(r.start);
    expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
  });

  it("超长区间降到周", () => {
    const since = new Date(2026, 0, 1).getTime();
    const until = since + 300 * DAY;
    const r = chooseBucket(since, until);
    expect(r.unit).toBe("week");
    expect(r.count).toBeLessThanOrEqual(420);
  });

  it("显式粒度被尊重", () => {
    const since = Date.now() - 6 * DAY;
    const r = chooseBucket(since, Date.now(), "hour" as UsageBucketUnit);
    expect(r.unit).toBe("hour");
  });
});

describe("usage aggregate", () => {
  it("汇总总数、命中率与来源分组", () => {
    const since = new Date(2026, 9, 25, 0, 0).getTime();
    const until = since + DAY;
    const rows = [
      row(new Date(2026, 9, 25, 1, 10).getTime(), { source: "main", input: 100, output: 20, cacheRead: 100, total: 220 }),
      row(new Date(2026, 9, 25, 2, 10).getTime(), { source: "judge", input: 10, output: 5, cacheRead: 0, total: 15 }),
    ];
    const agg = aggregateUsage(rows, since, until);
    expect(agg.totals.requests).toBe(2);
    expect(agg.totals.total).toBe(235);
    expect(agg.totals.input).toBe(110);
    expect(agg.totals.output).toBe(25);
    expect(agg.totals.cacheRead).toBe(100);
    expect(agg.totals.cacheHitRate).toBeCloseTo(100 / 210, 6);
    expect(agg.bySource.map((s) => s.key)).toEqual(["main", "judge"]);
    expect(agg.byModel[0]?.requests).toBe(2);
  });

  it("空桶会补齐,便于直接画折线", () => {
    const since = new Date(2026, 9, 25, 0, 0).getTime();
    const until = since + 4 * 3_600_000;
    const agg = aggregateUsage([row(since + 30 * 60_000)], since, until, "hour");
    expect(agg.buckets.length).toBe(4);
    expect(agg.buckets[0]?.requests).toBe(1);
    expect(agg.buckets[1]?.requests).toBe(0);
    expect(agg.buckets[1]?.cacheHitRate).toBe(0);
  });

  it("上一周期汇总独立计算", () => {
    const since = new Date(2026, 9, 25, 0, 0).getTime();
    const rows = [row(since + 1000, { input: 10, output: 0, cacheRead: 0, total: 10 })];
    const prev = [row(since - 1000, { input: 20, output: 0, cacheRead: 0, total: 20 })];
    const agg = aggregateUsage(rows, since, since + 3_600_000, "hour", prev);
    expect(agg.previous.total).toBe(20);
    expect(agg.totals.total).toBe(10);
  });
});
