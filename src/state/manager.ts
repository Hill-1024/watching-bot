import type { StateContext, StateSnapshot } from "./types.js";
import type { CoreCommands, CoreEvent, Emitter } from "../core/events.js";
import type { FeelingKind } from "../core/copy.js";
import { MIN } from "../core/clock.js";
import type { JudgeConfig } from "../config.js";

export interface ManagerDeps {
  events: Emitter<CoreEvent>;
  core: CoreCommands;
  ctx: StateContext;
  thresholds: StateContext["thresholds"];
  judge: JudgeConfig;
  simNow(): number;
  log?(msg: string): void;
}

interface FeelingTrack {
  tier: number;
  lastSim: number;
}

/**
 * 状态管理器:隐藏的「agent 监控/控制器」。
 * 只消费核心事件流(turn/tool_call/perception/tick),维护五维状态,
 * 经 CoreCommands 施加影响。对任何具体模块(包括 napcat)零感知 ——
 * 它认识的世界里只有「工具调用带 social 标签」「发生了 mention 风暴」这类语义。
 */
export class StateManager {
  private feelings = new Map<FeelingKind, FeelingTrack>();
  private judgeCallsToday = 0;
  private judgeLastSim = -Infinity;
  private judgeTodayKey = "";
  private readonly log: (msg: string) => void;

  constructor(private readonly deps: ManagerDeps) {
    this.log = deps.log ?? (() => {});
  }

  start(): void {
    this.deps.events.on((e) => this.onCoreEvent(e));
  }

  private onCoreEvent(e: CoreEvent): void {
    switch (e.type) {
      case "turn_end":
        this.deps.core.applyState({ type: "turn" });
        break;
      case "tool_call":
        for (const tag of e.tags) {
          this.deps.core.applyState({ type: "toolTag", tag });
        }
        break;
      case "perception":
        this.deps.core.applyState({ type: "perception", kind: e.kind, intensity: e.intensity });
        break;
      case "alarm_rang":
        this.deps.core.applyState({ type: "alarmRing" });
        break;
      case "phase_changed":
        if (e.phase === "sleep_transition") this.deps.core.applyState({ type: "sleepStart" });
        if (e.phase === "awake") this.deps.core.applyState({ type: "wake" });
        break;
    }
    this.evaluate();
  }

  /** 每次事件后评估阈值,必要时施加影响 */
  private evaluate(): void {
    const s = this.deps.core.snapshotNow();
    const th = this.deps.thresholds;

    if (s.phase === "asleep" || s.phase === "sleep_transition") {
      // 自然醒:疲惫恢复到阈值以下,系统直接唤醒
      if (s.vars.fatigue !== undefined && s.vars.fatigue <= th.naturalWake && s.phase === "asleep") {
        this.log(`[state] 疲惫已恢复(${fmt(s.vars.fatigue)})≤${th.naturalWake},自然醒`);
        this.deps.core.forceWake("natural");
      }
      return;
    }

    if (s.phase !== "awake") return;

    // 强制入睡
    if ((s.vars.fatigue ?? 0) >= th.forcedSleep) {
      this.log(`[state] 疲惫爆表(${fmt(s.vars.fatigue ?? 0)})≥${th.forcedSleep},强制入睡`);
      this.deps.core.requestSleep("fatigue");
      return;
    }

    // 阈值 → 体感注入(带冷却与升档立即)
    const fat = s.vars.fatigue ?? 0;
    this.feelIf("drowsy", fat >= th.drowsyTier3 ? 3 : tierOf(fat, th.drowsyInject, th.drowsyTier2));
    this.feelIf("irritated", tierOf(s.vars.annoyance ?? 0, 45, 70));
    this.feelIf("down", tierOf(-(s.vars.mood ?? 0), 30, 60));
    this.feelIf("anxious", tierOf(s.vars.stress ?? 0, 55, 80));
    this.feelIf("drained", tierOf(100 - (s.vars.social ?? 100), 70, 88));

    this.maybeJudge(s);
  }

  private feelIf(kind: FeelingKind, tier: number): void {
    if (tier <= 0) {
      this.feelings.delete(kind); // 回落到阈值下,允许下次重新从档1注入
      return;
    }
    const cooldown = this.deps.thresholds.feelingRepeatCooldownSimMinutes * MIN;
    const now = this.deps.simNow();
    const prev = this.feelings.get(kind);
    if (prev && prev.tier === tier && now - prev.lastSim < cooldown) return;
    if (this.deps.core.queueFeeling(kind, tier)) {
      this.feelings.set(kind, { tier, lastSim: now });
      this.log(`[state] 注入体感 ${kind} T${tier}`);
    }
  }

  /**
   * 双通道 LLM 修正之实时通道:
   * 这里只做限流记账;真正的 judge 调用由外部(judge 模块,M4)调用 applyJudgeCorrection。
   */
  private maybeJudge(_s: StateSnapshot): void {
    // 实时修正通道由 judge 模块挂载(M4)。此处保留限流状态。
  }

  /** judge 模块(M4)调用:应用一次修正,带每日次数与冷却限制 */
  applyJudgeCorrection(moodDelta: number, stressDelta: number): boolean {
    const now = this.deps.simNow();
    const todayKey = new Date(now).toISOString().slice(0, 10);
    if (todayKey !== this.judgeTodayKey) {
      this.judgeTodayKey = todayKey;
      this.judgeCallsToday = 0;
    }
    if (this.judgeCallsToday >= this.deps.judge.maxCallsPerSimDay) return false;
    if (now - this.judgeLastSim < this.deps.judge.cooldownSimMinutes * MIN) return false;
    this.judgeCallsToday++;
    this.judgeLastSim = now;
    this.deps.core.applyState({ type: "judgeCorrection", moodDelta, stressDelta });
    this.log(`[state] judge 修正 mood${moodDelta >= 0 ? "+" : ""}${moodDelta} stress${stressDelta >= 0 ? "+" : ""}${stressDelta}`);
    return true;
  }
}

function tierOf(value: number, t1: number, t2: number): number {
  if (value >= t2) return 2;
  if (value >= t1) return 1;
  return 0;
}

function fmt(v: number): string {
  return v.toFixed(1);
}
