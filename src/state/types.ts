import type { StateRules, StateThresholds, StateVarDef } from "../config.js";

/** 配置驱动的状态变量集合(v1:疲惫/心情/烦躁/压力/社交电量,可增删) */
export type Vars = Record<string, number>;

export type Phase = "awake" | "sleep_transition" | "asleep" | "waking";

export interface StateSnapshot {
  vars: Vars;
  phase: Phase;
  /** 当前睡眠开始时间(模拟 ms),未睡眠为 null */
  sleepStartedSim: number | null;
  /** 本次睡眠内被唤醒信号打断的次数(赖床计数) */
  snoozeCount: number;
}

export type StateEvent =
  | { type: "tick"; simDeltaMs: number }
  | { type: "turn" }
  | { type: "perception"; kind: string; intensity: number }
  | { type: "toolTag"; tag: string }
  | { type: "sleepStart" }
  | { type: "wake" }
  | { type: "alarmRing" }
  | { type: "judgeCorrection"; moodDelta?: number; stressDelta?: number }
  | { type: "setVar"; name: string; value: number };

export interface StateContext {
  defs: Record<string, StateVarDef>;
  rules: StateRules;
  thresholds: StateThresholds;
}

export function clamp(v: number, def: StateVarDef): number {
  return Math.min(def.max, Math.max(def.min, v));
}

export function initSnapshot(ctx: StateContext): StateSnapshot {
  const vars: Vars = {};
  for (const [name, def] of Object.entries(ctx.defs)) vars[name] = def.init;
  return { vars, phase: "awake", sleepStartedSim: null, snoozeCount: 0 };
}

export function fatigue(s: StateSnapshot): number {
  return s.vars.fatigue ?? 0;
}

export function varOf(s: StateSnapshot, name: string): number {
  return s.vars[name] ?? 0;
}
