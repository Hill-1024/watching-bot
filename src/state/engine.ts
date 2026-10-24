import { HOUR } from "../core/clock.js";
import type { StateContext, StateEvent, StateSnapshot } from "./types.js";
import { clamp } from "./types.js";

/**
 * 确定性规则引擎:纯函数,只做变量动力学。
 * 阈值判断/注入决策在 state/manager,这里不出现任何「该注入什么」的知识。
 */
export function applyStateEvent(
  prev: StateSnapshot,
  event: StateEvent,
  ctx: StateContext,
): StateSnapshot {
  const vars: Record<string, number> = { ...prev.vars };
  const snap: StateSnapshot = { ...prev, vars };
  const r = ctx.rules;
  const set = (name: string, delta: number) => {
    const def = ctx.defs[name];
    if (!def) return;
    vars[name] = clamp((vars[name] ?? def.init) + delta, def);
  };
  const setAbs = (name: string, value: number) => {
    const def = ctx.defs[name];
    if (!def) return;
    vars[name] = clamp(value, def);
  };

  switch (event.type) {
    case "tick": {
      const dh = event.simDeltaMs / HOUR;
      if (prev.phase !== "awake") {
        // 睡着/转换中/半梦半醒:都按恢复算
        set("fatigue", -r.fatigueRecoveryPerSimHour * dh);
        set("annoyance", -r.annoyanceDecayPerSimHour * 3 * dh);
        set("stress", -r.stressDecayPerSimHour * 2 * dh);
        set("social", r.socialRecoveryPerSimHourAlone * 0.5 * dh);
      } else {
        set("fatigue", r.fatiguePerSimHourAwake * dh);
        set("annoyance", -r.annoyanceDecayPerSimHour * dh);
        set("stress", -r.stressDecayPerSimHour * dh);
        set("social", r.socialRecoveryPerSimHourAlone * dh);
        const baseline = r.moodBaseline;
        const mood = vars.mood ?? baseline;
        setAbs("mood", mood + (baseline - mood) * Math.min(1, r.moodRegressionToBaselinePerSimHour * dh));
      }
      break;
    }
    case "turn":
      set("fatigue", r.fatiguePerTurn);
      break;
    case "perception": {
      const k = event.kind;
      if (k === "mention") set("annoyance", r.annoyancePerStormTick * event.intensity);
      else if (k === "message") set("social", -0.3 * event.intensity); // 环境闲聊只轻微耗电,主力消耗在主动社交(toolTag)
      else if (k === "mention_storm") set("annoyance", r.annoyancePerStormTick * 2 * event.intensity);
      else if (k === "alert") set("stress", 3 * event.intensity);
      break;
    }
    case "toolTag":
      if (event.tag === "social") {
        set("social", -6);
        set("mood", 1.5);
      }
      break;
    case "sleepStart":
      set("mood", 2);
      break;
    case "wake":
      set("mood", 1);
      break;
    case "alarmRing":
      set("annoyance", r.annoyancePerAlarmRing);
      set("mood", -1);
      break;
    case "judgeCorrection":
      if (event.moodDelta) set("mood", event.moodDelta);
      if (event.stressDelta) set("stress", event.stressDelta);
      break;
    case "setVar":
      setAbs(event.name, event.value);
      break;
  }
  return snap;
}
