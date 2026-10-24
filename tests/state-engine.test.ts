import { describe, expect, it } from "vitest";
import { applyStateEvent } from "../src/state/engine.js";
import { initSnapshot, type StateContext, type StateSnapshot } from "../src/state/types.js";
import { renderFeeling } from "../src/core/copy.js";
import type { FeelingKind } from "../src/core/copy.js";
import { HOUR } from "../src/core/clock.js";

const ctx: StateContext = {
  defs: {
    fatigue: { min: 0, max: 100, init: 30 },
    mood: { min: -100, max: 100, init: 10 },
    annoyance: { min: 0, max: 100, init: 0 },
    stress: { min: 0, max: 100, init: 10 },
    social: { min: 0, max: 100, init: 80 },
  },
  rules: {
    fatiguePerSimHourAwake: 5.5,
    fatiguePerTurn: 0.4,
    fatigueRecoveryPerSimHour: 14,
    annoyanceDecayPerSimHour: 3,
    annoyancePerAlarmRing: 9,
    annoyancePerStormTick: 4,
    stressDecayPerSimHour: 1.5,
    socialRecoveryPerSimHourAlone: 2,
    moodRegressionToBaselinePerSimHour: 0.5,
    moodBaseline: 10,
  },
  thresholds: {
    drowsyInject: 45,
    drowsyTier2: 65,
    drowsyTier3: 78,
    forcedSleep: 90,
    naturalWake: 15,
    drowsyOnWake: 40,
    sleepHardCapSimMinutes: 720,
    alarmRingIntervalSimMinutes: 10,
    stormWindowSimMinutes: 3,
    stormMinMentions: 5,
    feelingRepeatCooldownSimMinutes: 45,
  },
};

function phase(s: StateSnapshot, phase: StateSnapshot["phase"]): StateSnapshot {
  return { ...s, phase };
}

describe("state engine", () => {
  it("初始化快照取 defs.init", () => {
    const s = initSnapshot(ctx);
    expect(s.vars.fatigue).toBe(30);
    expect(s.vars.mood).toBe(10);
    expect(s.phase).toBe("awake");
  });

  it("清醒 tick:疲惫累积、烦躁/压力衰减、社交恢复", () => {
    let s = initSnapshot(ctx);
    s = phase(s, "awake");
    s = applyStateEvent(s, { type: "tick", simDeltaMs: HOUR }, ctx);
    expect(s.vars.fatigue).toBeCloseTo(35.5, 5);
    expect(s.vars.social).toBeCloseTo(82, 5);
  });

  it("睡眠 tick:疲惫恢复、烦躁加速衰减", () => {
    let s = initSnapshot(ctx);
    s.vars.fatigue = 90;
    s.vars.annoyance = 50;
    s = phase(s, "asleep");
    s = applyStateEvent(s, { type: "tick", simDeltaMs: HOUR }, ctx);
    expect(s.vars.fatigue).toBeCloseTo(76, 5);
    expect(s.vars.annoyance).toBeCloseTo(41, 5); // 3*3=9/h
  });

  it("变量钳制在 [min,max]", () => {
    let s = initSnapshot(ctx);
    s = phase(s, "asleep");
    s.vars.fatigue = 3;
    s = applyStateEvent(s, { type: "tick", simDeltaMs: 10 * HOUR }, ctx);
    expect(s.vars.fatigue).toBe(0); // 不低于 min
  });

  it("turn 增加疲惫;mention 增加烦躁;social 标签消耗社交电量并提升心情", () => {
    let s = initSnapshot(ctx);
    s = phase(s, "awake");
    s = applyStateEvent(s, { type: "turn" }, ctx);
    expect(s.vars.fatigue).toBeCloseTo(30.4, 5);
    s = applyStateEvent(s, { type: "perception", kind: "mention", intensity: 2 }, ctx);
    expect(s.vars.annoyance).toBeCloseTo(8, 5);
    s = applyStateEvent(s, { type: "toolTag", tag: "social" }, ctx);
    expect(s.vars.social).toBeCloseTo(74, 5);
    expect(s.vars.mood).toBeCloseTo(11.5, 5);
  });

  it("闹钟响铃:烦躁+9 心情-1;judge 修正生效", () => {
    let s = initSnapshot(ctx);
    s = applyStateEvent(s, { type: "alarmRing" }, ctx);
    expect(s.vars.annoyance).toBe(9);
    expect(s.vars.mood).toBe(9);
    s = applyStateEvent(s, { type: "judgeCorrection", moodDelta: -5, stressDelta: 3 }, ctx);
    expect(s.vars.mood).toBe(4);
    expect(s.vars.stress).toBe(13);
  });

  it("心情向基线回归", () => {
    let s = initSnapshot(ctx);
    s.vars.mood = -50;
    s = phase(s, "awake");
    s = applyStateEvent(s, { type: "tick", simDeltaMs: HOUR }, ctx);
    expect(s.vars.mood).toBeGreaterThan(-50);
    expect(s.vars.mood).toBeLessThan(10);
  });
});

describe("体感文案安全", () => {
  const kinds: FeelingKind[] = ["drowsy", "irritated", "down", "drained", "anxious", "post_wake_drowsy"];
  it("所有体感文案不含数字(状态数值永不泄漏进提示词)", () => {
    for (const k of kinds) {
      for (const tier of [1, 2, 3]) {
        const text = renderFeeling(k, tier);
        expect(text.length).toBeGreaterThan(4);
        expect(text).not.toMatch(/\d/);
      }
    }
  });
});
