import { MIN } from "./clock.js";
import type { Repo } from "../store/db.js";
import type { EnvKind, FeelingKind } from "./copy.js";
import type { Emitter, CoreEvent } from "./events.js";

export type MachinePhase = "awake" | "resting" | "sleep_transition" | "asleep" | "waking";

export interface MachineHost {
  simNow(): number;
  injectEnv(kind: EnvKind, arg?: { n?: number; count?: number; note?: string }): void;
  injectRawEnv(text: string): void;
  injectFeeling(kind: FeelingKind, tier: number): void;
  /** 排程一次尽快的 kick(去重) */
  requestKick(reason: string): void;
  /** 排程一次未来 kick(如入睡被拒后的下次尝试) */
  scheduleKickIn(simMs: number, reason: string): void;
  events: Emitter<CoreEvent>;
  repo: Repo;
  /** 睡眠转换钩子:执行记忆归并(睡眠期长期记忆整理),完成后调用返回的回调 */
  runConsolidation(): Promise<void>;
  fatigueNow(): number;
  drowsyOnWakeThreshold(): number;
  /** 不困门槛:疲惫低于此值时入睡工具拒绝(不困的人睡不着) */
  minFatigueToSleep(): number;
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
  /** 躺下放空(resting)的起点与累计次数,用于文案差异与恢复节奏 */
  restStartedSim: number | null = null;
  restAttempts = 0;
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

  /**
   * 自愿入睡是一次「尝试」,不是系统判定的许可。
   * - 够困 → 进入入睡流程(睡眠期归并 → asleep);
   * - 不够困 → 躺下放空(resting):安静恢复,但不视为睡着。
   *   真实的人不困时躺下也是辗转反侧,模型自己从体感里读出「还睡不着」,
   *   想等困意、想起来做事、或者继续躺着,都由它决定。
   */
  async sleepVoluntarily(): Promise<string> {
    if (this.phase === "waking") {
      this.settleBackToSleep();
      return "你迷迷糊糊地嘟囔了一句,翻了个身继续睡。";
    }
    if (this.phase === "asleep" || this.phase === "sleep_transition") return "你已经睡着了。";
    if (this.phase === "resting") return "你已经躺着了,脑子还在慢慢转,先别急着再躺一次。";

    const fatigue = this.host.fatigueNow();
    if (fatigue < this.host.minFatigueToSleep()) {
      this.phase = "resting";
      this.restStartedSim = this.host.simNow();
      this.restAttempts += 1;
      this.host.events.emit({ type: "phase_changed", phase: this.phase, reason: `rest:${this.restAttempts}` });
      const variants = [
        "你躺下闭上眼,但脑子还在转:今天没说完的话、没回的消息,都在眼前过。身体不累,意识清醒得很。先这么躺着吧,躺一会儿再说。",
        "被子拉好,眼睛闭上,可一点睡意都没有。翻了个身,索性发会儿呆。",
        "你试着睡,但脑子停不下来。不困就是不困,躺着也挺好。",
      ];
      return variants[(this.restAttempts - 1) % variants.length]!;
    }
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
    } else if (source === "private_message") {
      this.host.injectEnv("private_wake");
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
    this.restStartedSim = null;
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
