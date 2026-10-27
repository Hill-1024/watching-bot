import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import start from "../plugins/builtin/server/index.js";
import { JsonPluginStorage } from "../src/plugins/storage.js";
import type { PluginContext } from "../src/plugins/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-builtin-"));
  dirs.push(dir);
  return dir;
}

function ctxFor(dir: string, simNow: number, extra: Record<string, unknown> = {}): PluginContext {
  return {
    id: "builtin",
    manifest: { schemaVersion: 1, id: "builtin", name: "Builtin", version: "1", description: "", entry: "" },
    config: {
      overrideFile: join(dir, "builtin.json"),
      master: { qq: 10001, name: "阿岚" },
      coffee: { dailyQuota: 3, refillSimHour: 8 },
      ...extra,
    },
    dataDir: dir,
    simNow: () => simNow,
    realNow: () => simNow,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    storage: new JsonPluginStorage(join(dir, "store.json")),
    emitPerception: () => {},
  };
}

const GET = { method: "GET", path: "", query: {}, body: null } as const;

describe("builtin 插件:配置", () => {
  it("面板可更新称呼/QQ/配额并持久化到覆盖层", async () => {
    const dir = tempDir();
    const plugin = await start(ctxFor(dir, Date.UTC(2026, 9, 25, 12, 0, 0)));

    const initial = (await plugin.handle!(GET)) as { body: { master: unknown; coffee: unknown } };
    expect(initial.body.master).toEqual({ qq: 10001, name: "阿岚" });
    expect(plugin.tools![0]?.description ?? "").toContain("阿岚");

    const res = (await plugin.handle!({
      method: "POST",
      path: "config",
      query: {},
      body: { master: { qq: 10002, name: "小满" }, coffee: { dailyQuota: 5 } },
    })) as { body: { state: { master: unknown; coffee: { dailyQuota: number; refillSimHour: number } } } };

    expect(res.body.state.master).toEqual({ qq: 10002, name: "小满" });
    expect(res.body.state.coffee.dailyQuota).toBe(5);
    expect(res.body.state.coffee.refillSimHour).toBe(8);
    expect(plugin.tools![0]?.description ?? "").toContain("小满");

    const persisted = JSON.parse(readFileSync(join(dir, "builtin.json"), "utf-8")) as {
      master: { qq: number; name: string };
      coffee: { dailyQuota: number };
    };
    expect(persisted.master).toEqual({ qq: 10002, name: "小满" });
    expect(persisted.coffee.dailyQuota).toBe(5);
    await plugin.stop();
  });

  it("非法配额被钳制,空称呼不覆盖已有称呼", async () => {
    const dir = tempDir();
    const plugin = await start(ctxFor(dir, Date.UTC(2026, 9, 25, 12, 0, 0)));
    const res = (await plugin.handle!({
      method: "POST",
      path: "config",
      query: {},
      body: { master: { name: "   " }, coffee: { dailyQuota: 99 } },
    })) as { body: { state: { master: { name: string }; coffee: { dailyQuota: number } } } };
    expect(res.body.state.master.name).toBe("阿岚");
    expect(res.body.state.coffee.dailyQuota).toBe(50);
    await plugin.stop();
  });
});

describe("builtin 插件:咖啡余量", () => {
  it("喝咖啡消耗配额并上报 stimulant 感知", async () => {
    const dir = tempDir();
    const seen: unknown[] = [];
    const ctx = ctxFor(dir, Date.UTC(2026, 9, 25, 12, 0, 0));
    ctx.emitPerception = (e) => seen.push(e);
    const plugin = await start(ctx);
    const tool = plugin.tools![0]!;

    const r = (await tool.execute("t", {} as never)) as { details: { remaining: number } };
    expect(r.details.remaining).toBe(2);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { kind: string }).kind).toBe("stimulant");

    for (let i = 0; i < 2; i++) await tool.execute("t", {} as never);
    const empty = (await tool.execute("t", {} as never)) as { content: { text: string }[] };
    expect(empty.content[0]!.text).toContain("见底");
    await plugin.stop();
  });

  it("重启后余量不重置(私有存储持久化)", async () => {
    const dir = tempDir();
    const now = Date.UTC(2026, 9, 25, 12, 0, 0);
    const first = await start(ctxFor(dir, now));
    await first.tools![0]!.execute("t", {} as never);
    await first.stop();

    // 同一天重启,不应重新补满
    const second = await start(ctxFor(dir, now + 60_000));
    const state = (await second.handle!(GET)) as { body: { remaining: number } };
    expect(state.body.remaining).toBe(2);
    await second.stop();
  });

  it("跨日到补给时刻自动补满", async () => {
    const dir = tempDir();
    const day1 = Date.UTC(2026, 9, 25, 12, 0, 0);
    const first = await start(ctxFor(dir, day1));
    await first.tools![0]!.execute("t", {} as never);
    await first.stop();

    const day2 = Date.UTC(2026, 9, 26, 12, 0, 0);
    const second = await start(ctxFor(dir, day2));
    const state = (await second.handle!(GET)) as { body: { remaining: number } };
    expect(state.body.remaining).toBe(3);
    await second.stop();
  });

  it("grant 与 refill 动作可用,非法杯数被拒绝", async () => {
    const dir = tempDir();
    const plugin = await start(ctxFor(dir, Date.UTC(2026, 9, 25, 12, 0, 0)));
    const granted = (await plugin.handle!({
      method: "POST",
      path: "grant",
      query: {},
      body: { cups: 2 },
    })) as { body: { state: { remaining: number } } };
    expect(granted.body.state.remaining).toBe(5);

    const bad = await plugin.handle!({ method: "POST", path: "grant", query: {}, body: { cups: -1 } });
    expect(bad.status).toBe(400);

    const refilled = (await plugin.handle!({ method: "POST", path: "refill", query: {}, body: null })) as {
      body: { state: { remaining: number } };
    };
    expect(refilled.body.state.remaining).toBe(3);

    const missing = await plugin.handle!({ method: "GET", path: "nope", query: {}, body: null });
    expect(missing.status).toBe(404);
    await plugin.stop();
  });
});
