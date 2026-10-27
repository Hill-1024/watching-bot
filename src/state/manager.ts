import type { StateContext, StateSnapshot, Vars } from "./types.js";
import type { CoreCommands, CoreEvent, Emitter } from "../core/events.js";
import type { FeelingKind } from "../core/copy.js";
import { MIN } from "../core/clock.js";
import type { JudgeConfig } from "../config.js";
import { PulseLimiter, pulseLimitsOf, type PulseView } from "./aggregator.js";
import { StateChangeLog, type StateChange, type StateChangePage, type StateChangeSource } from "./changes.js";

export interface ManagerDeps {
  events: Emitter<CoreEvent>;
  core: CoreCommands;
  ctx: StateContext;
  thresholds: StateContext["thresholds"];
  judge: JudgeConfig;
  simNow(): number;
  log?(msg: string): void;
  /** 测试注入用;默认按 ctx.rules 构造 */
  limiter?: PulseLimiter;
  changeLog?: StateChangeLog;
  /** 状态发生变化时通知(面板按 topic 订阅,不需要轮询) */
  onChange?: () => void;
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
 *
 * 三条不变量:
 * 1. 它是唯一的状态事件应用者与阈值评估者(核心只发事实);
 * 2. 高频事件先进 PulseLimiter,按模拟时间窗口封顶,状态不随消息条数失控;
 * 3. 每次变化都记一条 StateChange,面板能回答「为什么变」。
 */
export class StateManager {
  private feelings = new Map<FeelingKind, FeelingTrack>();
  private judgeCallsToday = 0;
  private judgeLastSim = -Infinity;
  private judgeTodayKey = "";
  private readonly log: (msg: string) => void;
  private readonly limiter: PulseLimiter;
  private readonly changes: StateChangeLog;

  constructor(private readonly deps: ManagerDeps) {
    this.log = deps.log ?? (() => {});
    this.limiter = deps.limiter ?? new PulseLimiter(pulseLimitsOf(deps.ctx.rules));
    this.changes = deps.changeLog ?? new StateChangeLog();
  }

  start(): void {
    this.deps.events.on((e) => this.onCoreEvent(e));
  }

  private onCoreEvent(e: CoreEvent): void {
    switch (e.type) {
      case "tick":
        this.apply("tick", `tick +${Math.round(e.simDeltaMs / MIN)}m`, { type: "tick", simDeltaMs: e.simDeltaMs });
        break;
      case "turn_end":
        // 疲惫的 turn 成本由 loop 在每次 run 结束时施加一次(按 run 而非按 assistant 消息)。
        // 这里不能再加一遍,否则一次 run 会被重复计费多次。
        break;
      case "tool_call":
        for (const tag of e.tags) this.applyToolTag(e.name, tag);
        break;
      case "perception":
        this.applyPerception(e.kind, e.intensity);
        break;
      case "alarm_rang":
        this.apply("alarm", "alarm", { type: "alarmRing" });
        break;
      case "phase_changed":
        if (e.phase === "sleep_transition") this.apply("phase", `sleep:${e.reason}`, { type: "sleepStart" });
        if (e.phase === "awake") this.apply("phase", `wake:${e.reason}`, { type: "wake" });
        break;
    }
    this.evaluate();
  }

  /**
   * 应用一次状态事件并记录变化原因。
   * 只记录实际发生变化的变量,避免面板被零增量刷屏。
   */
  private apply(source: StateChangeSource, reason: string, event: Parameters<CoreCommands["applyState"]>[0]): void {
    const before: Vars = { ...this.deps.core.snapshotNow().vars };
    const next = this.deps.core.applyState(event);
    const after: Vars = { ...next.vars };
    const delta: Vars = {};
    let changed = false;
    for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const d = (after[name] ?? 0) - (before[name] ?? 0);
      if (Math.abs(d) > 1e-9) {
        delta[name] = d;
        changed = true;
      }
    }
    if (changed) {
      this.changes.record({ tsSim: this.deps.simNow(), source, reason, delta, before, after });
      this.deps.onChange?.();
    }
  }

  private applyPerception(kind: string, intensity: number): void {
    if (!(intensity > 0)) return;
    // 提神等生理摄入是离散事实,不受社交/风暴限率约束
    if (kind === "stimulant") {
      this.apply("perception", kind, { type: "perception", kind, intensity });
      return;
    }
    const granted = this.limiter.grantPerception(intensity, this.deps.simNow());
    if (granted <= 0) {
      this.log(`[state] 感知 ${kind} 落在限率窗口外(本窗口已饱和)`);
      return;
    }
    this.apply("perception", `${kind} x${round1(granted)}`, { type: "perception", kind, intensity: granted });
  }

  private applyToolTag(name: string, tag: string): void {
    if (tag === "social") {
      if (!this.limiter.grantSocialTool(this.deps.simNow())) {
        this.log(`[state] 社交工具 ${name} 超出窗口配额,本次不计入社交电量`);
        return;
      }
    }
    this.apply("tool", `${name}:${tag}`, { type: "toolTag", tag });
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

  // ---------- 面板可观测 ----------

  /** 最近状态变化(因果链) */
  recentChanges(limit = 50): StateChange[] {
    return this.changes.recent(limit);
  }

  /** 增量拉取状态变化 */
  changesSince(after: number, limit = 100): StateChangePage {
    return this.changes.since(after, limit);
  }

  /** 当前高频事件限率窗口的快照(面板显示 suppressed 计数) */
  pulseView(): PulseView {
    return this.limiter.view();
  }

  /** judge 模块(睡眠通道/实时通道)调用:应用一次修正,带开关、每日次数与冷却限制 */
  applyJudgeCorrection(moodDelta: number, stressDelta: number): boolean {
    if (!this.deps.judge.enabled) return false;
    const now = this.deps.simNow();
    const todayKey = new Date(now).toISOString().slice(0, 10);
    if (todayKey !== this.judgeTodayKey) {
      this.judgeTodayKey = todayKey;
      this.judgeCallsToday = 0;
    }
    if (this.judgeCallsToday >= this.deps.judge.maxCallsPerSimDay) {
      this.log("[state] judge 修正被拒:今日额度已用完");
      return false;
    }
    if (now - this.judgeLastSim < this.deps.judge.cooldownSimMinutes * MIN) {
      this.log("[state] judge 修正被拒:冷却中");
      return false;
    }
    this.judgeCallsToday++;
    this.judgeLastSim = now;
    this.apply("judge", "judge correction", { type: "judgeCorrection", moodDelta, stressDelta });
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

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export type { StateSnapshot };
