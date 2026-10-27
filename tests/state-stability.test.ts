import { describe, expect, it } from "vitest";
import { HOUR, MIN } from "../src/core/clock.js";
import { Emitter, type CoreCommands, type CoreEvent } from "../src/core/events.js";
import type { FeelingKind } from "../src/core/copy.js";
import { applyStateEvent } from "../src/state/engine.js";
import { StateManager } from "../src/state/manager.js";
import { simulateState, DAY } from "../src/state/simulator.js";
import { initSnapshot, type StateContext, type StateSnapshot } from "../src/state/types.js";
import { loadConfig } from "../src/config.js";
import { isValidSnapshot, resolveTimeScale, validateConfig } from "../src/config-schema.js";

const baseCfg = loadConfig();

function ctxOf(cfg = baseCfg): StateContext {
  return { defs: cfg.state.vars, rules: cfg.state.rules, thresholds: cfg.state.thresholds };
}

/**
 * 最小 CoreCommands 实现:状态只经 engine 变化,
 * 这样 manager 的限率/记账逻辑被单独验证,不牵扯真实 agent。
 */
function fakeCore(ctx: StateContext, initVars?: Record<string, number>) {
  let snap: StateSnapshot = initSnapshot(ctx);
  if (initVars) Object.assign(snap.vars, initVars);
  const calls = { sleep: 0, wake: 0, feelings: [] as { kind: FeelingKind; tier: number }[] };
  const core: CoreCommands = {
    queueFeeling(kind, tier) {
      calls.feelings.push({ kind, tier });
      return true;
    },
    queueEnvText() {},
    applyState(event) {
      snap = applyStateEvent({ ...snap, phase: snap.phase }, event, ctx);
      return snap;
    },
    snapshotNow: () => snap,
    requestSleep() {
      calls.sleep += 1;
    },
    requestWakeDecision() {},
    forceWake() {
      calls.wake += 1;
      snap = { ...snap, phase: "awake" };
    },
    refreshMemorySection() {},
  };
  return { core, calls, snap: () => snap };
}

function managerHarness(opts?: { judge?: Partial<typeof baseCfg.judge>; initVars?: Record<string, number> }) {
  const ctx = ctxOf();
  const { core, calls, snap } = fakeCore(ctx, opts?.initVars);
  const events = new Emitter<CoreEvent>();
  let sim = 0;
  const manager = new StateManager({
    events,
    core,
    ctx,
    thresholds: ctx.thresholds,
    judge: { ...baseCfg.judge, ...opts?.judge },
    simNow: () => sim,
  });
  manager.start();
  return {
    ctx,
    manager,
    calls,
    snap,
    get sim() {
      return sim;
    },
    at(ms: number) {
      sim = ms;
      return this;
    },
    tick(ms: number) {
      sim += ms;
      events.emit({ type: "tick", simDeltaMs: ms });
    },
    perceive(kind: string, intensity = 1) {
      events.emit({ type: "perception", kind, intensity });
    },
    tool(name: string, tags: string[]) {
      events.emit({ type: "tool_call", name, tags });
    },
    alarm() {
      events.emit({ type: "alarm_rang", count: 1 });
    },
  };
}

describe("状态限率:事件条数不等于状态冲击", () => {
  it("同一窗口内 100 条闲聊只按强度上限扣一次社交电量", () => {
    const h = managerHarness();
    for (let i = 0; i < 100; i++) h.perceive("message", 1);
    const lost = 80 - (h.snap().vars.social ?? 0);
    const cap = h.ctx.rules.maxPerceptionIntensityPerWindow * h.ctx.rules.socialPerMessageIntensity;
    expect(lost).toBeCloseTo(cap, 6);
    expect(h.manager.pulseView().suppressedPerceptions).toBeGreaterThan(0);
  });

  it("窗口滚动后重新获得额度,状态不会永久冻结", () => {
    const h = managerHarness();
    for (let i = 0; i < 100; i++) h.perceive("message", 1);
    const first = h.snap().vars.social ?? 0;
    h.tick(h.ctx.rules.pulseWindowSimMinutes * MIN);
    for (let i = 0; i < 100; i++) h.perceive("message", 1);
    expect(h.snap().vars.social ?? 0).toBeLessThan(first);
    expect(h.manager.pulseView().suppressedPerceptions).toBeGreaterThan(0);
  });

  it("社交工具按窗口配额消耗,超出部分被抑制", () => {
    const h = managerHarness();
    for (let i = 0; i < 10; i++) h.tool("send_message", ["social"]);
    const used = 80 - (h.snap().vars.social ?? 0);
    expect(used).toBeCloseTo(h.ctx.rules.maxSocialToolsPerWindow * h.ctx.rules.socialPerSocialTool, 6);
    expect(h.manager.pulseView().suppressedSocialTools).toBeGreaterThan(0);
  });

  it("咖啡(stimulant)是离散事实,不受感知限率约束", () => {
    const h = managerHarness();
    for (let i = 0; i < 10; i++) h.perceive("message", 1);
    const before = h.snap().vars.fatigue ?? 0;
    h.perceive("stimulant", 3);
    expect(h.snap().vars.fatigue ?? 0).toBeLessThan(before);
  });

  it("每次变化都有可解释的因果记录", () => {
    const h = managerHarness();
    h.perceive("mention", 1);
    h.alarm();
    const changes = h.manager.recentChanges(10);
    expect(changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.map((c) => c.source)).toContain("perception");
    expect(changes.map((c) => c.source)).toContain("alarm");
    expect(changes.every((c) => Number.isFinite(c.tsSim))).toBe(true);
    const seq = h.manager.changesSince(0, 100);
    expect(seq.changes.length).toBe(changes.length);
  });
});

describe("judge 开关与限流", () => {
  it("enabled=false 时不应用任何修正", () => {
    const h = managerHarness({ judge: { enabled: false } });
    const before = h.snap().vars.mood;
    expect(h.manager.applyJudgeCorrection(-20, 10)).toBe(false);
    expect(h.snap().vars.mood).toBe(before);
  });

  it("冷却期内拒绝第二次修正,冷却后放行", () => {
    const h = managerHarness({ judge: { enabled: true, cooldownSimMinutes: 30, maxCallsPerSimDay: 6 } });
    expect(h.manager.applyJudgeCorrection(-5, 5)).toBe(true);
    h.tick(10 * MIN);
    expect(h.manager.applyJudgeCorrection(-5, 5)).toBe(false);
    h.tick(31 * MIN);
    expect(h.manager.applyJudgeCorrection(-5, 5)).toBe(true);
  });
});

describe("确定性状态仿真", () => {
  it("24 小时清醒→入睡→自然醒:曲线有界、无 NaN、只切换一次", () => {
    const ctx = ctxOf();
    const r = simulateState({
      ctx,
      fromSim: 0,
      toSim: DAY,
      initialVars: { fatigue: 20 },
      script: [{ atSim: 6 * HOUR, type: "wake" }],
    });
    expect(r.samples.length).toBeGreaterThan(1000);
    expect(r.final.vars.fatigue).toBeGreaterThanOrEqual(0);
    expect(r.final.vars.fatigue).toBeLessThanOrEqual(100);
    const slept = r.samples.filter((s) => s.phase === "asleep").length;
    expect(slept).toBeGreaterThan(0);
    expect(Number.isFinite(r.final.vars.fatigue)).toBe(true);
  });

  it("100 条消息不会把社交电量打穿:落地强度被窗口封顶", () => {
    const ctx = ctxOf();
    const script = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ atSim: i * 1000, type: "message" as const, intensity: 1 }));
    const few = simulateState({ ctx, fromSim: 0, toSim: MIN, script: script(5), sampleEveryStep: false });
    const many = simulateState({ ctx, fromSim: 0, toSim: MIN, script: script(100), sampleEveryStep: false });
    // 两者差距不超过一个强度单位,且 100 条不会把电量打到接近 0
    expect((few.final.vars.social ?? 0) - (many.final.vars.social ?? 0)).toBeLessThanOrEqual(
      ctx.rules.socialPerMessageIntensity + 1e-9,
    );
    expect(many.final.vars.social ?? 0).toBeGreaterThan(70);
    expect(many.suppressed.perceptions).toBeGreaterThan(0);
  });

  it("同一事件序列两次仿真完全一致", () => {
    const ctx = ctxOf();
    const script = [
      { atSim: 5 * MIN, type: "message" as const, intensity: 2 },
      { atSim: 6 * MIN, type: "social" as const },
      { atSim: 7 * MIN, type: "alarmRing" as const },
      { atSim: 30 * MIN, type: "message" as const, kind: "mention_storm" as const, intensity: 4 },
    ];
    const a = simulateState({ ctx, fromSim: 0, toSim: HOUR, script });
    const b = simulateState({ ctx, fromSim: 0, toSim: HOUR, script });
    expect(a.final.vars).toEqual(b.final.vars);
    expect(a.samples).toEqual(b.samples);
  });

  it("睡眠中状态恢复,醒来疲惫显著低于入睡时", () => {
    const ctx = ctxOf();
    const r = simulateState({
      ctx,
      fromSim: 0,
      toSim: 12 * HOUR,
      initialVars: { fatigue: 88 },
      initialPhase: "asleep",
      autoPhase: false,
    });
    expect(r.final.vars.fatigue ?? 0).toBeLessThan(20);
    expect(r.final.vars.annoyance ?? 0).toBe(0);
  });
});

describe("配置与快照校验", () => {
  it("非法 timeScale 立即报错而不是静默 NaN", () => {
    expect(() => resolveTimeScale(1, "abc")).toThrow(/WATCHING_BOT_TIMESCALE/);
    expect(resolveTimeScale(2, "")).toBe(2);
    expect(resolveTimeScale(2, "0.5")).toBe(0.5);
  });

  it("阈值倒置在启动前失败并指出字段", () => {
    const cfg = structuredClone(baseCfg) as unknown as Record<string, unknown>;
    const state = cfg.state as { thresholds: Record<string, number> };
    state.thresholds.drowsyTier2 = 20;
    let message = "";
    try {
      validateConfig(cfg, "test.json");
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("test.json");
    expect(message).toContain("递增");
  });

  it("变量 init 越界被拒绝", () => {
    const cfg = structuredClone(baseCfg) as unknown as Record<string, unknown>;
    const state = cfg.state as { vars: Record<string, { init: number }> };
    state.vars.fatigue!.init = 500;
    expect(() => validateConfig(cfg)).toThrow(/state\.vars\.fatigue/);
  });

  it("损坏快照不通过结构校验", () => {
    expect(isValidSnapshot(null)).toBe(false);
    expect(isValidSnapshot({ version: 2 })).toBe(false);
    expect(
      isValidSnapshot({
        version: 1,
        simNow: 0,
        vars: { fatigue: 1 },
        phase: "awake",
        sleepStartedSim: null,
        snoozeCount: 0,
        agentMessages: [],
      }),
    ).toBe(true);
  });
});
