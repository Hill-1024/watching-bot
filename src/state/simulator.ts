import { HOUR, MIN } from "../core/clock.js";
import type { StateContext, StateSnapshot, Vars } from "./types.js";
import { initSnapshot } from "./types.js";
import { applyStateEvent } from "./engine.js";
import { PulseLimiter, pulseLimitsOf } from "./aggregator.js";

/** 仿真脚本事件:只描述「发生了什么事实」,不描述「状态该怎么变」 */
export type SimScriptEvent =
  | { atSim: number; type: "message"; intensity?: number; kind?: "message" | "mention" | "mention_storm" | "alert" | "stimulant" }
  | { atSim: number; type: "social" }
  | { atSim: number; type: "turn" }
  | { atSim: number; type: "alarmRing" }
  | { atSim: number; type: "sleep" }
  | { atSim: number; type: "wake" }
  | { atSim: number; type: "setVar"; name: string; value: number };

export interface SimSample {
  atSim: number;
  phase: StateSnapshot["phase"];
  vars: Vars;
}

export interface SimResult {
  samples: SimSample[];
  final: StateSnapshot;
  /** 每个变量在整段仿真里的极值,用于断言「有界」 */
  range: Record<string, { min: number; max: number }>;
  suppressed: { perceptions: number; socialTools: number };
}

export interface SimulateOptions {
  ctx: StateContext;
  fromSim: number;
  toSim: number;
  /** 采样步长,同时也是 tick 粒度 */
  stepSimMs?: number;
  script?: SimScriptEvent[];
  /** 初始变量覆盖 */
  initialVars?: Vars;
  initialPhase?: StateSnapshot["phase"];
  /**
   * 是否按真实阈值自动切换 phase(强制入睡/自然醒/睡眠硬上限)。
   * 默认 true —— 仿真要跑「一整天」就不能只跑恒定的清醒动力学。
   */
  autoPhase?: boolean;
  /** 每步都采样(默认 true);false 时只记录 phase 变化点 */
  sampleEveryStep?: boolean;
}

/**
 * 确定性状态仿真器。
 *
 * 与线上共用同一套 engine + PulseLimiter,因此仿真结果可以当真:
 * 参数调整、限率窗口、咖啡/风暴/社交脉冲都可以在没有 LLM、没有时钟的情况下复现。
 * 用途是「先证明曲线有界且可解释,再拿去调性格」,而不是替代面板观察。
 */
export function simulateState(opts: SimulateOptions): SimResult {
  const step = Math.max(1, opts.stepSimMs ?? MIN);
  const limiter = new PulseLimiter(pulseLimitsOf(opts.ctx.rules));
  const autoPhase = opts.autoPhase ?? true;
  const th = opts.ctx.thresholds;

  let snap: StateSnapshot = initSnapshot(opts.ctx);
  if (opts.initialVars) Object.assign(snap.vars, opts.initialVars);
  if (opts.initialPhase) snap.phase = opts.initialPhase;
  if (snap.phase === "asleep" || snap.phase === "sleep_transition") snap.sleepStartedSim = opts.fromSim;

  const script = [...(opts.script ?? [])].sort((a, b) => a.atSim - b.atSim);
  let cursor = 0;
  const samples: SimSample[] = [];
  const range: Record<string, { min: number; max: number }> = {};
  let lastPhase = snap.phase;

  const sample = (atSim: number) => {
    const vars = { ...snap.vars };
    tooBig(vars);
    samples.push({ atSim, phase: snap.phase, vars });
    for (const [name, v] of Object.entries(vars)) {
      const r = (range[name] ??= { min: v, max: v });
      if (v < r.min) r.min = v;
      if (v > r.max) r.max = v;
    }
  };

  const setPhase = (atSim: number, phase: StateSnapshot["phase"]) => {
    if (phase === snap.phase) return;
    snap.phase = phase;
    if (phase === "sleep_transition") {
      snap.sleepStartedSim = atSim;
      snap.snoozeCount = 0;
    }
    if (phase === "asleep" && snap.sleepStartedSim == null) snap.sleepStartedSim = atSim;
    if (phase === "awake") snap.sleepStartedSim = null;
  };

  for (let now = opts.fromSim; now <= opts.toSim; now += step) {
    // 1. 落地本步到期的脚本事件
    while (cursor < script.length && script[cursor]!.atSim <= now) {
      const ev = script[cursor++]!;
      snap = applyScriptEvent(snap, ev, opts.ctx, limiter);
    }

    // 2. 时间步进
    snap = applyStateEvent(snap, { type: "tick", simDeltaMs: step }, opts.ctx);

    // 3. 真实阈值驱动的 phase 迁移(与 StateManager 的判定一致)
    if (autoPhase) {
      const tired = snap.vars.fatigue ?? 0;
      if (snap.phase === "awake" && tired >= th.forcedSleep) {
        setPhase(now, "asleep");
      } else if (snap.phase === "asleep") {
        const slept = snap.sleepStartedSim != null ? now - snap.sleepStartedSim : 0;
        if (tired <= th.naturalWake || slept >= th.sleepHardCapSimMinutes * MIN) {
          setPhase(now, "awake");
        }
      }
    }

    if (opts.sampleEveryStep !== false || snap.phase !== lastPhase) sample(now);
    lastPhase = snap.phase;
  }

  const pv = limiter.view();
  return {
    samples,
    final: snap,
    range,
    suppressed: { perceptions: pv.suppressedPerceptions, socialTools: pv.suppressedSocialTools },
  };
}

function applyScriptEvent(
  snap: StateSnapshot,
  ev: SimScriptEvent,
  ctx: StateContext,
  limiter: PulseLimiter,
): StateSnapshot {
  switch (ev.type) {
    case "sleep":
      return { ...snap, phase: "asleep", sleepStartedSim: ev.atSim, snoozeCount: 0 };
    case "wake":
      return { ...snap, phase: "awake", sleepStartedSim: null };
    case "turn":
      return applyStateEvent(snap, { type: "turn" }, ctx);
    case "alarmRing":
      return applyStateEvent(snap, { type: "alarmRing" }, ctx);
    case "setVar":
      return applyStateEvent(snap, { type: "setVar", name: ev.name, value: ev.value }, ctx);
    case "social": {
      if (!limiter.grantSocialTool(ev.atSim)) return snap;
      return applyStateEvent(snap, { type: "toolTag", tag: "social" }, ctx);
    }
    case "message": {
      const kind = ev.kind ?? "message";
      const intensity = ev.intensity ?? 1;
      if (kind === "stimulant") {
        return applyStateEvent(snap, { type: "perception", kind, intensity }, ctx);
      }
      const granted = limiter.grantPerception(intensity, ev.atSim);
      if (granted <= 0) return snap;
      return applyStateEvent(snap, { type: "perception", kind, intensity: granted }, ctx);
    }
    default: {
      // 穷尽检查:新增脚本事件类型时这里会编译失败,而不是静默丢事件
      const never: never = ev;
      throw new Error(`未知仿真事件: ${JSON.stringify(never)}`);
    }
  }
}

/** 仿真护栏:任何 NaN/Infinity 都是参数或实现错误,必须当场炸掉而不是悄悄污染历史 */
function tooBig(vars: Vars): void {
  for (const [name, v] of Object.entries(vars)) {
    if (!Number.isFinite(v)) throw new Error(`状态变量 ${name} 出现非有限值: ${v}`);
  }
}

export const DAY = 24 * HOUR;
