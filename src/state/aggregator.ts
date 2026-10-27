import { MIN } from "../core/clock.js";
import type { StateRules } from "../config.js";

export interface PulseLimits {
  /** 限率窗口长度(模拟分钟);<=0 表示不限率 */
  windowSimMinutes: number;
  /** 单个窗口内允许落地的感知强度总和 */
  maxPerceptionIntensity: number;
  /** 单个窗口内允许落地的社交工具调用次数 */
  maxSocialTools: number;
}

export interface PulseView {
  windowStartSim: number | null;
  perceptionIntensity: number;
  socialTools: number;
  suppressedPerceptions: number;
  suppressedSocialTools: number;
}

export function pulseLimitsOf(rules: StateRules): PulseLimits {
  return {
    windowSimMinutes: rules.pulseWindowSimMinutes,
    maxPerceptionIntensity: rules.maxPerceptionIntensityPerWindow,
    maxSocialTools: rules.maxSocialToolsPerWindow,
  };
}

/**
 * 高频事件按模拟时间窗口限率。
 *
 * 为什么要这一层:状态必须对「事件的性质」有反应,但对「事件的条数」不能无界敏感。
 * 一条消息和一百条消息是同一件事(有人在说话),一百个 @ 是另一件事(风暴)。
 * 因此感知强度按窗口封顶,社交工具调用按窗口计数封顶;超出部分记 suppressed,
 * 面板能回答「状态为什么没继续掉」。
 *
 * 纯内存、确定性:同一组 (intensity, nowSim) 序列在任何运行环境下结果一致。
 */
export class PulseLimiter {
  private windowStartSim: number | null = null;
  private perceptionIntensity = 0;
  private socialTools = 0;
  private suppressedPerceptions = 0;
  private suppressedSocialTools = 0;

  constructor(private readonly limits: PulseLimits) {}

  private windowMs(): number {
    return this.limits.windowSimMinutes * MIN;
  }

  private roll(nowSim: number): void {
    const w = this.windowMs();
    if (!(w > 0)) return;
    if (this.windowStartSim == null) {
      this.windowStartSim = nowSim;
      return;
    }
    if (nowSim < this.windowStartSim) {
      // 模拟时钟回拨(快照恢复/面板调 timeScale):新窗口从现在算起
      this.restart(nowSim);
      return;
    }
    const elapsed = nowSim - this.windowStartSim;
    if (elapsed < w) return;
    const steps = Math.floor(elapsed / w);
    this.windowStartSim += steps * w;
    this.perceptionIntensity = 0;
    this.socialTools = 0;
  }

  /**
   * 申请一段感知强度额度。
   * 返回实际允许落地的强度(0 表示本窗口已饱和)。
   */
  grantPerception(intensity: number, nowSim: number): number {
    if (!(intensity > 0)) return 0;
    const w = this.windowMs();
    if (!(w > 0)) return intensity;
    this.roll(nowSim);
    const remaining = Math.max(0, this.limits.maxPerceptionIntensity - this.perceptionIntensity);
    const granted = Math.min(intensity, remaining);
    this.perceptionIntensity += granted;
    if (granted < intensity) this.suppressedPerceptions += 1;
    return granted;
  }

  /** 申请一次社交工具额度;false 表示本窗口的社交预算用完了 */
  grantSocialTool(nowSim: number): boolean {
    const w = this.windowMs();
    if (!(w > 0)) return true;
    this.roll(nowSim);
    if (this.socialTools >= this.limits.maxSocialTools) {
      this.suppressedSocialTools += 1;
      return false;
    }
    this.socialTools += 1;
    return true;
  }

  restart(nowSim: number): void {
    this.windowStartSim = nowSim;
    this.perceptionIntensity = 0;
    this.socialTools = 0;
  }

  view(): PulseView {
    return {
      windowStartSim: this.windowStartSim,
      perceptionIntensity: this.perceptionIntensity,
      socialTools: this.socialTools,
      suppressedPerceptions: this.suppressedPerceptions,
      suppressedSocialTools: this.suppressedSocialTools,
    };
  }
}
