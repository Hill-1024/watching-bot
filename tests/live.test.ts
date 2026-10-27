import { describe, expect, it } from "vitest";
import { Coalescer, LiveHub } from "../src/web/live.js";

function collector() {
  const events: { topic: string; data?: unknown }[] = [];
  return { events, sink: (topic: string, data?: unknown) => events.push({ topic, data }) };
}

describe("LiveHub", () => {
  it("按 topic 广播,取消订阅后不再收到", () => {
    const hub = new LiveHub();
    const a = collector();
    const b = collector();
    const offA = hub.add({ send: (e) => a.sink(e.topic, e.data) });
    hub.add({ send: (e) => b.sink(e.topic, e.data) });

    hub.publish("activity");
    expect(a.events).toEqual([{ topic: "activity", data: undefined }]);
    expect(b.events).toHaveLength(1);

    offA();
    hub.publish("status", { phase: "awake" });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(2);
  });

  it("事件带递增 seq 与时间戳,便于前端排查乱序", () => {
    const hub = new LiveHub();
    const seen: { seq: number; at: number }[] = [];
    hub.add({ send: (e) => seen.push({ seq: e.seq, at: e.at }) });
    hub.publish("state");
    hub.publish("state");
    expect(seen.map((s) => s.seq)).toEqual([1, 2]);
    expect(seen.every((s) => Number.isFinite(s.at))).toBe(true);
  });
});

describe("Coalescer", () => {
  it("窗口内只推一次纯信号", () => {
    const c = collector();
    const coalescer = new Coalescer(c.sink, 50);
    coalescer.push("state");
    coalescer.push("state");
    coalescer.push("state");
    expect(c.events).toHaveLength(1);
  });

  it("内容相同的 payload 不重复推(没变就不刷新)", () => {
    const c = collector();
    const coalescer = new Coalescer(c.sink, 0);
    coalescer.push("plugins", { plugins: [1] });
    coalescer.push("plugins", { plugins: [1] });
    coalescer.push("plugins", { plugins: [2] });
    expect(c.events).toHaveLength(2);
  });

  it("immediate 绕过窗口(phase 变化这种要立刻看到)", () => {
    const c = collector();
    const coalescer = new Coalescer(c.sink, 60_000);
    coalescer.push("status", { phase: "awake" });
    coalescer.push("status", { phase: "asleep" });
    expect(c.events).toHaveLength(1);
    coalescer.push("status", { phase: "awake" }, { immediate: true });
    expect(c.events).toHaveLength(2);
  });

  it("插件 topic 可以零窗口(连接状态变化立即送达)", () => {
    const c = collector();
    const coalescer = new Coalescer(c.sink, 60_000);
    coalescer.push("plugin:qq", undefined, { windowMs: 0 });
    coalescer.push("plugin:qq", undefined, { windowMs: 0 });
    expect(c.events).toHaveLength(2);
  });
});
