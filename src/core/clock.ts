/**
 * timeScale 时钟:模拟时间 = simStart + (真实流逝时间 × scale)。
 * 所有状态动力学、闹钟、wait 都按模拟时间计算;QQ 消息收发永远走真实时间。
 */
export class SimClock {
  private scale: number;
  private realBase: number; // Date.now() at rebase
  private simBase: number; // sim epoch ms at rebase
  private tickTimer: NodeJS.Timeout | null = null;
  private tickCbs: ((simNow: number) => void)[] = [];
  private timers: { dueSim: number; cb: (simNow: number) => void; id: number }[] = [];
  private timerSeq = 1;
  readonly tickRealMs: number;

  constructor(opts: { simStart?: string; resumeSimNow?: number; timeScale: number; tickRealMs: number }) {
    this.scale = opts.timeScale;
    this.tickRealMs = opts.tickRealMs;
    this.realBase = Date.now();
    this.simBase = opts.resumeSimNow ?? new Date(opts.simStart ?? new Date().toISOString()).getTime();
  }

  get timeScale(): number {
    return this.scale;
  }

  /** 热调倍率(面板用),以当前时刻为锚重定基,不跳变 */
  setTimeScale(scale: number): void {
    const sim = this.simNow();
    this.realBase = Date.now();
    this.simBase = sim;
    this.scale = scale;
  }

  simNow(): number {
    return this.simBase + (Date.now() - this.realBase) * this.scale;
  }

  simDate(): Date {
    return new Date(this.simNow());
  }

  /** 模拟时间 → 真实等待毫秒 */
  simToRealMs(simMs: number): number {
    return simMs / this.scale;
  }

  /** 排程模拟时间回调。返回取消函数。 */
  scheduleIn(simMsFromNow: number, cb: (simNow: number) => void): () => void {
    const due = this.simNow() + simMsFromNow;
    return this.scheduleAt(due, cb);
  }

  scheduleAt(dueSim: number, cb: (simNow: number) => void): () => void {
    const id = this.timerSeq++;
    this.timers.push({ dueSim, cb, id });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  onTick(cb: (simNow: number) => void): void {
    this.tickCbs.push(cb);
  }

  start(): void {
    if (this.tickTimer) return;
    // 注意:不能 unref —— 时钟是无限循环的心跳,unref 会让进程没有任何活跃句柄而直接退出
    this.tickTimer = setInterval(() => {
      const sim = this.simNow();
      const due = this.timers.filter((t) => t.dueSim <= sim);
      if (due.length > 0) {
        this.timers = this.timers.filter((t) => t.dueSim > sim);
        for (const t of due) t.cb(sim);
      }
      for (const cb of this.tickCbs) cb(sim);
    }, this.tickRealMs);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
  }
}

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

export function fmtSim(simMs: number): string {
  const d = new Date(simMs);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
