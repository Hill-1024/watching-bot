import type { Repo } from "../store/db.js";
import type { EnvKind, FeelingKind } from "./copy.js";
import type { Emitter, CoreEvent } from "./events.js";

export type MachinePhase = "awake" | "sleep_transition" | "asleep" | "waking";

export interface MachineHost {
  simNow(): number;
  injectEnv(kind: EnvKind, arg?: { n?: number; count?: number; note?: string }): void;
  injectRawEnv(text: string): void;
  injectFeeling(kind: FeelingKind, tier: number): void;
  /** 排程一次尽快的 kick(去重) */
  requestKick(reason: string): void;
  events: Emitter<CoreEvent>;
  repo: Repo;
  /** 睡眠转换钩子:执行记忆归并(睡眠期长期记忆整理),完成后调用返回的回调 */
  runConsolidation(): Promise<void>;
  fatigueNow(): number;
  drowsyOnWakeThreshold(): number;
}

/**
 * 醒睡状态机。
 *
 * 唤醒语义(与产品设计一一对应):
 * - 自然醒/硬上限/面板强制 → forceWake:系统直接唤醒,不经模型决定
 * - 闹钟/@风暴 打断 → beginWaking:注入唤醒信号,模型自己决定 —— 调 wake_up 起床,
 *   或者不理会(run 结束后由 loop 判定为赖床,phase 回 asleep,响铃升级)
 */
export class SleepMachine {
  phase: MachinePhase = "awake";
  sleepStartedSim: number | null = null;
  snoozeCount = 0;
  /** 最近一次唤醒信号的来源(alarm/storm/…),loop 判定赖床后续用 */
  lastWakeSource = "";
  private sleepLogId: number | null = null;
  private sleepReason = "";
  private wakeSource = "";
  private transitioning = false;

  constructor(private readonly host: MachineHost) {}

  isAsleepLike(): boolean {
    return this.phase === "asleep" || this.phase === "sleep_transition";
  }

  async requestSleep(reason: string): Promise<void> {
    if (this.phase !== "awake") return;
    this.phase = "sleep_transition";
    this.sleepStartedSim = this.host.simNow();
    this.sleepReason = reason;
    this.snoozeCount = 0;
    this.host.events.emit({ type: "phase_changed", phase: this.phase, reason });
    if (this.transitioning) return;
    this.transitioning = true;
    try {
      await this.host.runConsolidation();
    } catch (err) {
      // 归并失败不挡入睡:记事件,继续睡
      this.host.events.emit({ type: "phase_changed", phase: "sleep_transition", reason: `consolidation_error:${String(err)}` });
    } finally {
      this.transitioning = false;
    }
    if (this.phase !== "sleep_transition") return; // 期间被强制唤醒
    if (reason !== "voluntary") this.host.injectEnv("forced_sleep");
    this.phase = "asleep";
    this.openSleepLog();
    this.host.events.emit({ type: "phase_changed", phase: this.phase, reason });
  }

  /** 自愿入睡;若正处于被叫醒的犹豫期,等价于赖床(拒绝起床) */
  async sleepVoluntarily(): Promise<string> {
    if (this.phase === "waking") {
      this.settleBackToSleep();
      return "你迷迷糊糊地嘟囔了一句,翻了个身继续睡。";
    }
    if (this.phase !== "awake") return "你已经睡着了。";
    await this.requestSleep("voluntary");
    return "你放下一切,钻进了被窝。意识慢慢沉入黑暗。";
  }

  /** 闹钟/风暴打断:注入信号,让模型决定起不起 */
  beginWaking(source: string, note?: string): void {
    if (this.phase !== "asleep") return;
    this.phase = "waking";
    this.wakeSource = source;
    this.lastWakeSource = source;
    this.host.events.emit({ type: "phase_changed", phase: this.phase, reason: source });
    if (source === "alarm") {
      this.host.injectEnv("alarm_ring", { count: this.snoozeCount + 1, note });
    } else if (source === "storm") {
      this.host.injectEnv("storm_sleep");
    } else {
      this.host.injectRawEnv(`有什么东西把你从睡梦中惊扰了(${source})。`);
    }
    this.host.requestKick(`wake-decision:${source}`);
  }

  /** 模型调了 wake_up:真起床 */
  confirmWake(): void {
    if (this.phase !== "waking") return;
    this.finishWake(`confirmed:${this.wakeSource}`);
  }

  /** 系统级唤醒:自然醒/硬上限/面板 —— 不问模型 */
  forceWake(reason: string): void {
    if (this.phase === "awake") return;
    if (this.phase === "sleep_transition") {
      // 转换中被强拉:标记,让 requestSleep 的收尾放弃入睡
      this.phase = "awake";
      this.host.events.emit({ type: "phase_changed", phase: "awake", reason });
      return;
    }
    if (reason === "natural") this.host.injectEnv("natural_wake");
    else if (reason === "hard_cap") this.host.injectEnv("forced_wake_cap");
    this.finishWake(reason);
  }

  /** run 结束时仍处于 waking:模型选择继续睡(赖床) */
  settleBackToSleep(): boolean {
    if (this.phase !== "waking") return false;
    this.phase = "asleep";
    this.snoozeCount += 1;
    this.host.events.emit({ type: "phase_changed", phase: "asleep", reason: `snooze:${this.wakeSource}` });
    return true;
  }

  private finishWake(reason: string): void {
    const now = this.host.simNow();
    if (this.sleepLogId != null) {
      this.host.repo.closeSleepLog(this.sleepLogId, now, reason, this.snoozeCount);
      this.sleepLogId = null;
    }
    const slept = this.sleepStartedSim != null ? now - this.sleepStartedSim : 0;
    this.phase = "awake";
    this.sleepStartedSim = null;
    this.wakeSource = "";
    // 没睡够就醒 → 继续困意注入
    if (this.host.fatigueNow() >= this.host.drowsyOnWakeThreshold()) {
      this.host.injectFeeling("post_wake_drowsy", 1);
    }
    this.host.events.emit({ type: "phase_changed", phase: "awake", reason: `${reason} sleptMs=${slept}` });
    this.host.requestKick("woke-up");
  }

  openSleepLog(): void {
    if (this.sleepLogId == null && this.sleepStartedSim != null) {
      this.sleepLogId = this.host.repo.insertSleepLog(this.sleepStartedSim, this.sleepReason);
    }
  }
}
