import type { ActivityEntry } from "./activity.js";

import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { ModuleBus } from "../bus/types.js";
import type { AppConfig } from "../config.js";
import { applyStateEvent } from "../state/engine.js";
import type { StateEvent, StateSnapshot } from "../state/types.js";
import type { Repo } from "../store/db.js";
import { MIN, type SimClock } from "./clock.js";
import type { EnvKind, FeelingKind } from "./copy.js";
import type { Injector } from "./inject.js";
import type { Emitter, CoreCommands, CoreEvent } from "./events.js";
import type { MachineHost, SleepMachine } from "./machine.js";
import type { StateContext } from "../state/types.js";

export interface MemoryProvider {
  /** MEMORY.md 当前内容(进系统提示 memory section) */
  indexText(): string;
}

export interface AgentCoreDeps {
  cfg: AppConfig;
  clock: SimClock;
  bus: ModuleBus;
  agent: Agent;
  injector: Injector;
  machine: SleepMachine;
  events: Emitter<CoreEvent>;
  repo: Repo;
  memory: MemoryProvider;
  log?: (msg: string) => void;
}

/**
 * 无限循环编排器:唯一决定「何时调用 LLM」的角色。
 *
 * kick = 把待注入消息 flush 进 transcript + 拼一条节拍消息 + 发起一次 pi run。
 * run 自然结束(模型不再调工具)→ 挂起,等下一个触发器(wait 到期/闹钟/感知/状态命令/心跳兜底)。
 * 防永眠:闹钟重复响铃 + 连续睡眠硬上限(状态管理器/面板触发 forceWake)。
 */
export class AgentCore implements CoreCommands, MachineHost {
  readonly clock: SimClock;
  readonly machine: SleepMachine;
  readonly events: Emitter<CoreEvent>;
  snapshot: StateSnapshot;

  private nextKickSim: number | null = null;
  private cancelKick: (() => void) | null = null;
  private kicking = false;
  private emptyBackoffMul = 1;
  private mentionTimes: number[] = [];
  private privateMsgTimes: number[] = [];
  private lastHistorySampleSim = 0;
  private lastTickSim: number | null = null;
  private lastAlarmNote: string | undefined;
  private readonly log: (msg: string) => void;

  private stateCtx: StateContext;

  constructor(private readonly deps: AgentCoreDeps) {
    this.clock = deps.clock;
    this.machine = deps.machine;
    this.events = deps.events;
    this.log = deps.log ?? (() => {});
    this.stateCtx = {
      defs: deps.cfg.state.vars,
      rules: deps.cfg.state.rules,
      thresholds: deps.cfg.state.thresholds,
    };
    this.snapshot = {
      vars: {},
      phase: "awake",
      sleepStartedSim: null,
      snoozeCount: 0,
    };
  }

  /** MachineHost 之 repo 面孔 */
  get repo(): Repo {
    return this.deps.repo;
  }

  // ---------- MachineHost(machine 回调的宿主面孔) ----------

  simNow(): number {
    return this.clock.simNow();
  }

  injectEnv(kind: EnvKind, arg?: { n?: number; count?: number; note?: string }): void {
    this.deps.injector.queueEnv(kind, arg);
  }

  injectRawEnv(text: string): void {
    this.deps.injector.queueRawEnvText(text);
  }

  injectFeeling(kind: FeelingKind, tier: number): void {
    this.deps.injector.queueFeeling(kind, tier);
  }

  fatigueNow(): number {
    return this.snapshot.vars.fatigue ?? 0;
  }

  drowsyOnWakeThreshold(): number {
    return this.deps.cfg.state.thresholds.drowsyOnWake;
  }

  minFatigueToSleep(): number {
    return this.deps.cfg.sleep.minFatigueToSleep;
  }

  /** 睡眠转换钩子:交给 memory 模块做睡眠期归并(由 index.ts 注入) */
  runConsolidation: () => Promise<void> = async () => {};

  /** 模块热插拔后刷新 agent 工具集与 capabilities section(由 index.ts 注入) */
  refreshAgentTools: () => void = () => {};

  // ---------- 活动日志(思维链/输出/工具调用,内存环形缓冲,面板消费) ----------

  private activitySeq = 0;
  private readonly activityBuf: ActivityEntry[] = [];
  private static readonly ACTIVITY_CAP = 400;
  private static readonly ACTIVITY_TEXT_CAP = 4000;

  private pushActivity(kind: ActivityEntry["kind"], text: string): void {
    const trimmed = text.slice(0, AgentCore.ACTIVITY_TEXT_CAP);
    this.activityBuf.push({ seq: ++this.activitySeq, tsSim: this.clock.simNow(), kind, text: trimmed });
    if (this.activityBuf.length > AgentCore.ACTIVITY_CAP) this.activityBuf.shift();
  }

  /** 面板拉取:after 之后的活动条目 */
  activitySince(after: number): { entries: ActivityEntry[]; lastSeq: number } {
    return {
      entries: this.activityBuf.filter((e) => e.seq > after),
      lastSeq: this.activitySeq,
    };
  }

  // ---------- 生命周期 ----------

  start(initialSnapshot: StateSnapshot): void {
    this.snapshot = initialSnapshot;
    this.snapshot.phase = this.machine.phase === "awake" ? "awake" : "asleep";

    // pi agent 事件 → 核心事件流
    this.deps.agent.subscribe((event) => {
      if (event.type === "turn_end") {
        const msg = event.message as { role: string; content?: unknown };
        const toolNames =
          msg.role === "assistant" && Array.isArray(msg.content)
            ? (msg.content as { type: string; name?: string }[])
                .filter((c) => c.type === "toolCall")
                .map((c) => c.name ?? "")
            : [];
        const textLen = this.assistantTextLen(event.message);
        this.applyState({ type: "turn" });
        this.events.emit({ type: "turn_end", toolNames, textLen });
      } else if (event.type === "message_end") {
        const m = event.message as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
        if (m.role === "assistant" && Array.isArray(m.content)) {
          for (const part of m.content as { type: string; thinking?: string; text?: string; name?: string; arguments?: unknown }[]) {
            if (part.type === "thinking" && part.thinking) this.pushActivity("thinking", part.thinking);
            else if (part.type === "text" && part.text) this.pushActivity("text", part.text);
            else if (part.type === "toolCall") {
              this.pushActivity("tool_call", `${part.name} ${JSON.stringify(part.arguments ?? {})}`);
            }
          }
          if (m.errorMessage) this.pushActivity("error", String(m.errorMessage));
          const tools = (m.content as { type: string; name?: string }[]).filter((c) => c.type === "toolCall").map((c) => c.name ?? "");
          const text = this.assistantTextLen(m) > 0 ? this.assistantText(m) : "";
          this.log(
            `[agent] stop=${m.stopReason}${m.errorMessage ? ` err=${m.errorMessage}` : ""}${tools.length ? ` tools=[${tools.join(",")}]` : ""}${text ? ` «${text.slice(0, 60)}»` : ""}`,
          );
        }
      } else if (event.type === "tool_execution_end") {
        const r = event.result as { content?: { type: string; text?: string }[] };
        const brief = Array.isArray(r?.content)
          ? (r.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join(" ")
          : "";
        this.pushActivity(event.isError ? "error" : "tool_result",
          `${event.toolName} → ${brief || (event.isError ? "(失败)" : "(无文本结果)")}`,
        );
      } else if (event.type === "tool_execution_start") {
        this.events.emit({
          type: "tool_call",
          name: event.toolName,
          tags: this.deps.bus.toolTags(event.toolName),
        });
      }
    });

    // 模块感知 → 归一化聚合
    this.deps.bus.onPerception((e) => this.onPerception(e.kind, e.intensity, e.source));

    // 时钟 tick:闹钟检查 + @风暴窗口聚合 + 硬上限
    this.clock.onTick((sim) => this.onTick(sim));

    // 开局一踢,进入无限循环
    this.requestKick("boot");
  }

  stop(): void {
    this.cancelKick?.();
    this.cancelKick = null;
    this.nextKickSim = null;
    this.deps.agent.abort();
  }

  // ---------- CoreCommands ----------

  queueFeeling(kind: Parameters<CoreCommands["queueFeeling"]>[0], tier: number): boolean {
    const queued = this.deps.injector.queueFeeling(kind, tier);
    // 有新体感未消化 → 提前踢一次,让模型「感觉到」
    if (queued && this.machine.phase === "awake") {
      this.scheduleKickAt(this.clock.simNow() + 1 * MIN, "feeling");
    }
    return queued;
  }

  queueEnvText(text: string): void {
    this.deps.injector.queueRawEnvText(text);
    if (this.machine.phase === "awake") {
      this.scheduleKickAt(this.clock.simNow() + 1 * MIN, "env");
    }
  }

  applyState(event: StateEvent): StateSnapshot {
    // phase 以 machine 为准传给引擎(决定清醒/睡眠动力学),引擎结果只回写快照
    const prev = { ...this.snapshot, phase: this.machine.phase as StateSnapshot["phase"] };
    const next = applyStateEvent(prev, event, this.stateCtx);
    next.sleepStartedSim = this.machine.sleepStartedSim;
    next.snoozeCount = this.machine.snoozeCount;
    this.snapshot = next;
    this.maybeSampleHistory();
    return next;
  }

  snapshotNow(): StateSnapshot {
    return this.snapshot;
  }

  requestSleep(source: string): void {
    void this.machine.requestSleep(source).catch((err) => this.log(`[loop] requestSleep 异常: ${String(err)}`));
  }

  requestWakeDecision(source: string, note?: string): void {
    if (this.machine.phase !== "asleep") return;
    this.machine.beginWaking(source, note);
    this.snapshot.phase = "waking";
  }

  forceWake(source: string): void {
    this.machine.forceWake(source);
    this.snapshot.phase = "awake";
  }

  refreshMemorySection(): void {
    this.deps.injector.queueSystemSections({ memory: this.deps.memory.indexText() });
    if (this.machine.phase === "awake") {
      this.scheduleKickAt(this.clock.simNow() + 1 * MIN, "memory-refresh");
    }
  }

  // ---------- kick 调度 ----------

  /** 尽快踢一次(去重:已排程的更早 kick 优先) */
  requestKick(reason: string): void {
    if (this.kicking || this.deps.agent.state.isStreaming) return;
    this.scheduleKickAt(this.clock.simNow(), `kick:${reason}`);
  }

  scheduleKickIn(simMs: number, reason: string): void {
    this.scheduleKickAt(this.clock.simNow() + simMs, reason);
  }

  private scheduleKickAt(atSim: number, reason: string): void {
    if (this.nextKickSim != null && this.nextKickSim <= atSim) return;
    this.cancelKick?.();
    this.nextKickSim = atSim;
    const delayReal = Math.max(0, this.clock.simToRealMs(atSim - this.clock.simNow()));
    this.log(`[loop] 排程 kick @sim+${Math.round(delayReal)}ms (${reason})`);
    this.cancelKick = this.clock.scheduleAt(atSim, () => {
      this.nextKickSim = null;
      this.cancelKick = null;
      void this.runKick(reason);
    });
  }

  /** 一次 kick = 一次 pi run */
  private async runKick(reason: string): Promise<void> {
    if (this.kicking) return;
    if (this.machine.phase !== "awake" && this.machine.phase !== "waking") return; // 睡着/转换中不踢
    const agent = this.deps.agent;
    if (agent.state.isStreaming) {
      // 运行中来触发:转 steer 注入,不打断当前 run
      const pending = this.deps.injector.drain();
      for (const m of pending) agent.steer(m);
      return;
    }
    this.kicking = true;
    try {
      const batch: AgentMessage[] = this.deps.injector.drain();
      batch.push({
        role: "user",
        content: `[节拍] (${reason}) 时间在走。用你的工具去感受和行动,没有想做的事就 wait 或 sleep。`,
        timestamp: Date.now(),
      });
      this.log(`[loop] kick (${reason}),注入 ${batch.length - 1} 条`);
      await agent.prompt(batch);
      await agent.waitForIdle();
    } catch (err) {
      this.log(`[loop] run 异常: ${String(err)}`);
    } finally {
      this.kicking = false;
    }
    this.onRunEnd(reason);
  }

  // ---------- run 结束评估 ----------

  private onRunEnd(reason: string): void {
    const machine = this.machine;

    // waking 窗口内没调 wake_up → 赖床
    if (machine.phase === "waking") {
      const source = machine.lastWakeSource;
      const snoozed = machine.settleBackToSleep();
      if (snoozed && machine.snoozeCount >= this.deps.cfg.sleep.maxSnoozeBeforeForcedWake) {
        this.deps.injector.queueRawEnvText("被吵了一次又一次,你终于睡意全无,烦躁地睁开了眼。");
        machine.forceWake("snooze_limit");
        this.snapshot.phase = "awake";
      } else if (snoozed && source === "alarm") {
        // 闹钟按掉了 → 隔一会儿真的重新入列再响(文案会升级「第 N 次」)
        const interval = this.deps.cfg.state.thresholds.alarmRingIntervalSimMinutes * MIN;
        this.deps.repo.addAlarm(this.clock.simNow() + interval, this.clock.simNow(), "agent", this.lastAlarmNote);
        this.log(`[loop] 赖床 #${machine.snoozeCount},闹钟将在 ${this.deps.cfg.state.thresholds.alarmRingIntervalSimMinutes} 模拟分后重响`);
      } else if (snoozed) {
        // 风暴等来源:允许它继续睡,但风暴还在继续的话会再次打断(由聚合器驱动)
        this.scheduleKickIn(5 * MIN, "storm-rering");
      }
      return;
    }

    if (machine.phase !== "awake") return; // 已入睡,run 自然结束

    // 空响应退避:没调工具且几乎没说话
    const lastMsgs = agentTailTexts(this.deps.agent);
    const hadToolCalls = lastMsgs.toolCalls > 0;
    this.events.emit({ type: "run_end", hadToolCalls, textLen: lastMsgs.textLen });
    if (!hadToolCalls && lastMsgs.textLen < 8) {
      this.emptyBackoffMul = Math.min(
        this.emptyBackoffMul * 2,
        this.deps.cfg.loop.emptyBackoffMaxSimMinutes / this.deps.cfg.loop.emptyBackoffBaseSimMinutes,
      );
    } else {
      this.emptyBackoffMul = 1;
    }
    const idleSimMin = Math.min(
      this.deps.cfg.loop.heartbeatSimMinutes * this.emptyBackoffMul,
      this.deps.cfg.loop.emptyBackoffMaxSimMinutes,
    );
    // 有待注入体感 → 1 模拟分内感知;否则心跳/退避
    // 注意:模型已 wait(N) 时绝不提前心跳 —— 否则长 wait 被心跳砍短(「wait 是假的」bug)
    if (this.nextKickSim != null) {
      this.log(`[loop] 已有待触发(如 wait/闹钟),跳过心跳排程`);
      return;
    }
    const wait = this.deps.injector.pendingCount > 0 ? 1 : idleSimMin;
    this.scheduleKickIn(wait * MIN, `idle:x${this.emptyBackoffMul}`);
  }

  // ---------- 感知 ----------

  private onPerception(kind: string, intensity: number, source?: string): void {
    this.events.emit({ type: "perception", kind, intensity });
    if (kind === "mention") {
      this.mentionTimes.push(this.clock.simNow());
    }
    // 清醒时:消息/被@ → 微妙体感(按 kind 去重灌水),模型自己决定看不看
    if (this.machine.phase === "awake" && (kind === "message" || kind === "mention")) {
      const envKind = kind === "message" ? "message" : "mention";
      if (!this.deps.injector.hasPendingEnv(envKind)) {
        this.deps.injector.queueEnv(envKind);
        this.scheduleKickAt(this.clock.simNow() + 1 * MIN, "perception");
      }
    }
    // 睡眠中:群聊不吵醒;私聊累积达到阈值 → 唤醒决策(可赖床,赖床后继续累积会再次触发)
    if (this.machine.phase === "asleep" && kind === "message" && source?.startsWith("private:")) {
      const cfg = this.deps.cfg.sleep;
      if (!cfg.wakeOnPrivateMessage) return;
      this.privateMsgTimes.push(this.clock.simNow());
      const windowMs = cfg.privateWakeWindowSimMinutes * MIN;
      this.privateMsgTimes = this.privateMsgTimes.filter((t) => this.clock.simNow() - t <= windowMs);
      if (this.privateMsgTimes.length >= cfg.privateWakeMessages) {
        this.privateMsgTimes = [];
        // 烦躁累积:被私聊吵醒也算被打扰
        this.events.emit({ type: "perception", kind: "mention", intensity: 2 });
        this.requestWakeDecision("private_message");
      }
    }
  }

  // ---------- 时钟 tick ----------

  private onTick(sim: number): void {
    const cfg = this.deps.cfg;

    // 状态引擎按分钟步进
    this.stepStateTick(sim);

    // @风暴聚合
    const windowMs = cfg.state.thresholds.stormWindowSimMinutes * MIN;
    this.mentionTimes = this.mentionTimes.filter((t) => sim - t <= windowMs);
    if (this.mentionTimes.length >= cfg.state.thresholds.stormMinMentions) {
      this.mentionTimes = [];
      this.events.emit({ type: "perception", kind: "mention_storm", intensity: 4 });
      this.deps.injector.queueEnv("mention_storm");
      if (this.machine.phase === "asleep" && cfg.sleep.wakeOnStorm) {
        this.requestWakeDecision("storm");
      } else if (this.machine.phase === "awake") {
        this.scheduleKickAt(sim + 30_000, "storm");
      }
    }

    // 睡眠硬上限(模拟 12h)
    if (
      (this.machine.phase === "asleep" || this.machine.phase === "sleep_transition") &&
      this.machine.sleepStartedSim != null &&
      sim - this.machine.sleepStartedSim >= cfg.state.thresholds.sleepHardCapSimMinutes * MIN
    ) {
      this.log("[loop] 睡眠硬上限触发,强制唤醒");
      this.forceWake("hard_cap");
    }

    // 闹钟
    for (const a of this.deps.repo.duePendingAlarms(sim)) {
      this.deps.repo.markAlarm(a.id, "rang");
      this.events.emit({ type: "alarm_rang", count: this.machine.snoozeCount + 1 });
      this.lastAlarmNote = a.note ?? undefined;
      if (this.machine.phase === "asleep") {
        this.requestWakeDecision("alarm", a.note ?? undefined);
      } else if (this.machine.phase === "waking") {
        // 正在赖床犹豫 → 追加响铃烦躁
        this.deps.injector.queueEnv("alarm_ring", { count: this.machine.snoozeCount + 2, note: a.note ?? undefined });
      }
    }
  }

  private stepStateTick(sim: number): void {
    if (this.lastTickSim == null) {
      this.lastTickSim = sim;
      return;
    }
    const delta = sim - this.lastTickSim;
    if (delta >= MIN) {
      const steps = Math.floor(delta / MIN);
      this.lastTickSim += steps * MIN;
      this.applyState({ type: "tick", simDeltaMs: steps * MIN });
    }
  }

  private maybeSampleHistory(): void {
    const sim = this.clock.simNow();
    if (sim - this.lastHistorySampleSim >= MIN) {
      this.lastHistorySampleSim = sim;
      this.deps.repo.insertStateHistory(sim, this.snapshot.phase, this.snapshot.vars);
    }
  }

  private assistantTextLen(message: unknown): number {
    const m = message as { role?: string; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return 0;
    let n = 0;
    for (const part of m.content as { type: string; text?: string }[]) {
      if (part.type === "text" && part.text) n += part.text.length;
    }
    return n;
  }

  private assistantText(message: unknown): string {
    const m = message as { role?: string; content?: unknown };
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return "";
    return (m.content as { type: string; text?: string }[])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join(" / ");
  }
}

function agentTailTexts(agent: Agent): { toolCalls: number; textLen: number } {
  const msgs = agent.state.messages;
  let toolCalls = 0;
  let textLen = 0;
  for (let i = msgs.length - 1; i >= 0 && i >= msgs.length - 12; i--) {
    const m = msgs[i] as { role?: string; content?: unknown };
    if (m?.role === "user") break; // 只看最近一次 run
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const part of m.content as { type: string; text?: string }[]) {
        if (part.type === "toolCall") toolCalls++;
        else if (part.type === "text" && part.text) textLen += part.text.length;
      }
    }
  }
  return { toolCalls, textLen };
}
