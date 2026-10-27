import type { StateEvent, StateSnapshot } from "../state/types.js";
import type { FeelingKind } from "./copy.js";

/** 核心对外(状态管理器/面板)暴露的事件流 —— 只描述 agent 本体,无任何模块概念 */
export type CoreEvent =
  | { type: "tick"; simDeltaMs: number }
  | { type: "turn_end"; toolNames: string[]; textLen: number }
  | { type: "tool_call"; name: string; tags: string[] }
  | { type: "perception"; kind: string; intensity: number }
  | { type: "alarm_rang"; count: number }
  | { type: "run_end"; hadToolCalls: boolean; textLen: number }
  | { type: "phase_changed"; phase: string; reason: string };

/** 核心命令 API:状态管理器借此对 agent 施加影响(它唯一的手) */
export interface CoreCommands {
  /** 更新状态变量(走规则引擎,统一钳制与持久化);返回是否真的注入了 */
  queueFeeling(kind: FeelingKind, tier: number): boolean;
  /** 环境注入(自由文本,仅核心/面板内部使用) */
  queueEnvText(text: string): void;
  /** 更新状态变量(走规则引擎,统一钳制与持久化) */
  applyState(event: StateEvent): StateSnapshot;
  /** 读取当前快照 */
  snapshotNow(): StateSnapshot;
  /** 强制入睡(疲惫爆表/面板)——直接进入睡眠转换,不给模型选择 */
  requestSleep(source: string): void;
  /** 睡眠中被唤醒信号打断:注入信号,模型自己决定起不起(可赖床) */
  requestWakeDecision(source: string, note?: string): void;
  /** 系统级唤醒(自然醒/硬上限/面板):不经模型决定 */
  forceWake(source: string): void;
  /** 刷新系统提示的 memory section(归并完成后调用) */
  refreshMemorySection(): void;
}

/** 极简类型化事件分发 */
export class Emitter<T> {
  private cbs: ((e: T) => void)[] = [];
  on(cb: (e: T) => void): void {
    this.cbs.push(cb);
  }
  emit(e: T): void {
    for (const cb of [...this.cbs]) {
      try {
        cb(e);
      } catch (err) {
        console.error("[emitter] listener error", err);
      }
    }
  }
}
