import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, Repo } from "../src/store/db.js";
import { UsageRecorder } from "../src/core/usage.js";

const dirs: string[] = [];
function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "wb-store-"));
  dirs.push(dir);
  return new Repo(openDb(dir));
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("repo: activity log", () => {
  it("写入后分页返回 camelCase 时间字段(避免面板 NaN)", () => {
    const repo = makeRepo();
    repo.insertActivity(1000, 2000, "thinking", "想了一会儿");
    repo.insertActivity(3000, 4000, "text", "说了一句话");
    const page = repo.activityPage({ page: 1, pageSize: 10 });
    expect(page.total).toBe(2);
    expect(page.items[0]).toMatchObject({
      tsSim: 3000,
      tsReal: 4000,
      kind: "text",
      text: "说了一句话",
    });
    expect(Number.isFinite(page.items[0]!.tsSim)).toBe(true);
    repo.close();
  });

  it("支持 kind 过滤与文本搜索", () => {
    const repo = makeRepo();
    repo.insertActivity(1, 1, "thinking", "关于天气的想法");
    repo.insertActivity(2, 2, "text", "今天下雨");
    repo.insertActivity(3, 3, "text", "晚饭吃什么");
    expect(repo.activityPage({ page: 1, pageSize: 10, kinds: ["text"] }).total).toBe(2);
    expect(repo.activityPage({ page: 1, pageSize: 10, query: "下雨" }).items[0]?.text).toBe("今天下雨");
    repo.close();
  });
});

describe("repo: injections", () => {
  it("增量拉取只返回 afterId 之后的数据", () => {
    const repo = makeRepo();
    repo.insertInjection(1, "feeling", "drowsy", 1, "困");
    repo.insertInjection(2, "env", "message", null, "手机震了");
    repo.insertInjection(3, "feeling", "stressed", 2, "压力");
    const items = repo.injectionsAfter(1, 10);
    expect(items.map((i) => i.id)).toEqual([2, 3]);
    expect(repo.injectionPage({ page: 1, pageSize: 2 }).total).toBe(3);
    expect(repo.injectionPage({ page: 1, pageSize: 10, channel: "env" }).total).toBe(1);
    repo.close();
  });
});

describe("repo: token usage", () => {
  it("落库并按真实时间区间读取", () => {
    const repo = makeRepo();
    const clock = { simNow: () => 999 };
    const rec = new UsageRecorder(repo, clock);
    rec.record("main", {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 0,
      totalTokens: 170,
    }, { model: "m", provider: "p", tsReal: 1000 });
    rec.record("judge", { input: 0, output: 0, totalTokens: 0 }, { tsReal: 1100 });

    const rows = repo.tokenUsageBetween(500, 1500);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "main",
      model: "m",
      provider: "p",
      tsSim: 999,
      input: 100,
      output: 20,
      cacheRead: 50,
      total: 170,
    });
    repo.close();
  });

  it("状态历史区间按步长抽稀", () => {
    const repo = makeRepo();
    for (let i = 0; i < 100; i++) repo.insertStateHistory(i * 60_000, "awake", { fatigue: i });
    const rows = repo.stateHistoryRange(0, 100 * 60_000, 10);
    expect(rows.length).toBeLessThanOrEqual(20);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.ts_sim).toBeGreaterThanOrEqual(0);
    repo.close();
  });
});
