import type { Vars } from "./types.js";

export type StateChangeSource =
  | "tick"
  | "turn"
  | "perception"
  | "tool"
  | "alarm"
  | "judge"
  | "phase"
  | "panel";

/** 一次状态变更的可解释记录:面板据此回答「它为什么这样」 */
export interface StateChange {
  seq: number;
  tsSim: number;
  source: StateChangeSource;
  reason: string;
  delta: Vars;
  before: Vars;
  after: Vars;
}

export interface StateChangePage {
  changes: StateChange[];
  lastSeq: number;
  reset: boolean;
}

/**
 * 状态变更环形日志。
 * 只保留最近若干条:这是诊断/展示用的因果链,不是审计底账,
 * 长期趋势走 state_history 表(每分钟采样)。
 */
export class StateChangeLog {
  private seq = 0;
  private readonly buf: StateChange[] = [];

  constructor(private readonly cap = 400) {}

  record(entry: Omit<StateChange, "seq">): StateChange {
    const change: StateChange = { ...entry, seq: ++this.seq };
    this.buf.push(change);
    if (this.buf.length > this.cap) this.buf.shift();
    return change;
  }

  lastSeq(): number {
    return this.seq;
  }

  recent(limit = 50): StateChange[] {
    return this.buf.slice(-Math.max(1, limit));
  }

  /** 增量拉取:after 之后的变更;游标失效时 reset=true */
  since(after: number, limit = 100): StateChangePage {
    const firstSeq = this.buf[0]?.seq ?? this.seq + 1;
    const lastSeq = this.seq;
    const reset = after > 0 && (after > lastSeq || after < firstSeq - 1);
    const changes = (reset ? this.buf : this.buf.filter((c) => c.seq > after)).slice(-Math.max(1, limit));
    return { changes, lastSeq, reset };
  }
}
