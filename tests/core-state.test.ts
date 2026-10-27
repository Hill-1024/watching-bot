import type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { AgentCore } from "../src/core/loop.js";
import { SleepMachine, type MachineHost } from "../src/core/machine.js";
import { Emitter, type CoreEvent } from "../src/core/events.js";
import { Injector } from "../src/core/inject.js";
import { MIN, SimClock } from "../src/core/clock.js";
import { Repo, openDb } from "../src/store/db.js";
import { StateManager } from "../src/state/manager.js";
import { initSnapshot } from "../src/state/types.js";
import type { ModuleBus } from "../src/bus/types.js";

function repo(): Repo {
  return new Repo(openDb(":memory:"));
}

function bus(): ModuleBus {
  return {
    async startAll() {}, async stopAll() {}, allTools: () => [], toolTags: () => [],
    capabilitySection: () => "", status: () => [], onPerception: () => {},
  };
}

function harness(fatigue = 30) {
  const cfg = loadConfig();
  let sim = 0;
  let tick: ((sim: number) => void) | undefined;
  let agentEvent: ((event: { type: string; message: unknown }) => void) | undefined;
  const timers = new Map<number, { at: number; cb: (sim: number) => void }>();
  let timerSeq = 0;
  const steered: AgentMessage[] = [];
  const prompted: AgentMessage[][] = [];
  const clock = {
    simNow: () => sim,
    timeScale: 1,
    onTick: (cb: (sim: number) => void) => { tick = cb; },
    scheduleAt: (at: number, cb: (sim: number) => void) => {
      const id = ++timerSeq;
      timers.set(id, { at, cb });
      return () => { timers.delete(id); };
    },
    simToRealMs: (ms: number) => ms,
  } as unknown as SimClock;
  const agent = {
    state: { isStreaming: false, messages: [] as AgentMessage[] },
    subscribe: (cb: typeof agentEvent) => { agentEvent = cb; },
    steer: (message: AgentMessage) => { steered.push(message); },
    prompt: async (messages: AgentMessage[]) => { prompted.push(messages); },
    waitForIdle: async () => {},
    abort: () => {},
  } as unknown as Agent;
  const events = new Emitter<CoreEvent>();
  const storage = repo();
  const injector = new Injector(() => "openai-completions", storage, () => sim);
  const hostRef: { current: MachineHost | null } = { current: null };
  const host = new Proxy({} as MachineHost, {
    get: (_target, key) => {
      const value = hostRef.current?.[key as keyof MachineHost];
      return typeof value === "function" ? value.bind(hostRef.current) : value;
    },
  });
  const machine = new SleepMachine(host);
  const core = new AgentCore({
    cfg, clock, bus: bus(), agent, injector, machine, events, repo: storage,
    memory: { indexText: () => "" }, masterQQ: 0,
  });
  hostRef.current = core;
  const manager = new StateManager({
    events, core, ctx: { defs: cfg.state.vars, rules: cfg.state.rules, thresholds: cfg.state.thresholds },
    thresholds: cfg.state.thresholds, judge: cfg.judge, simNow: () => sim,
  });
  const initial = initSnapshot({ defs: cfg.state.vars, rules: cfg.state.rules, thresholds: cfg.state.thresholds });
  initial.vars.fatigue = fatigue;
  manager.start();
  core.start(initial);
  return {
    core, machine, storage, agent, timers, steered, prompted,
    fireTimers: () => {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        sim = timer.at;
        timer.cb(sim);
      }
    },
    turn: () => agentEvent?.({ type: "turn_end", message: { role: "assistant", content: [] } }),
    tick: (minutes: number) => {
      tick?.(sim);
      sim += minutes * MIN;
      tick?.(sim);
    },
  };
}

describe("core 与状态管理器集成", () => {
  it("一次 assistant turn 只应用一次疲惫增量", () => {
    const h = harness();
    try {
      h.turn();
      expect(h.core.snapshotNow().vars.fatigue).toBeCloseTo(30.2, 8);
    } finally {
      h.storage.close();
    }
  });

  it("时间 tick 跨过强制入睡阈值时立即评估", () => {
    const h = harness(89.95);
    try {
      h.tick(1);
      expect(h.machine.phase).not.toBe("awake");
    } finally {
      h.storage.close();
    }
  });

  it("睡眠中的时间 tick 恢复到自然醒阈值时立即唤醒", () => {
    const h = harness(15.1);
    try {
      h.machine.phase = "asleep";
      h.machine.sleepStartedSim = 0;
      h.core.snapshot.phase = "asleep";
      h.tick(1);
      expect(h.machine.phase).toBe("awake");
    } finally {
      h.storage.close();
    }
  });

  it("清醒时到期闹钟会注入提示而不是无声消费", () => {
    const h = harness();
    try {
      h.tick(0);
      h.storage.addAlarm(0, 0, "agent", "该起床了");
      h.tick(0);
      expect(h.core.snapshotNow().phase).toBe("awake");
      expect(h.storage.pendingAlarmCount()).toBe(0);
      expect(h.storage.recentInjections(5).some((i) => i.kind === "alarm_ring")).toBe(true);
    } finally {
      h.storage.close();
    }
  });

  it("入睡转换中的到期闹钟保持待处理,转换后仍可分发", () => {
    const h = harness();
    try {
      h.machine.phase = "sleep_transition";
      h.tick(0);
      h.storage.addAlarm(0, 0, "agent");
      h.tick(0);
      expect(h.storage.pendingAlarmCount()).toBe(1);
    } finally {
      h.storage.close();
    }
  });
});

describe("infinite loop 感知调度", () => {
  it("长 wait 中收到消息会提前排程,并在启动 kick 后只触发一次新 run", async () => {
    const h = harness();
    try {
      h.core.stop();
      h.timers.clear();
      h.core.scheduleKickIn(60 * MIN, "wait:60m");
      expect([...h.timers.values()][0]?.at).toBe(60 * MIN);
      (h.core as unknown as { onPerception(kind: string, intensity: number): void }).onPerception("message", 1);
      expect([...h.timers.values()][0]?.at).toBe(0);
      h.fireTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(h.prompted).toHaveLength(1);
      expect(h.prompted[0]?.some((m) => typeof m.content === "string" && m.content.includes("[环境]"))).toBe(true);
    } finally {
      h.storage.close();
    }
  });

  it("正在输出时的新消息不打断当前回合,也不补踢", () => {
    const h = harness();
    try {
      h.core.stop();
      h.timers.clear();
      h.agent.state.isStreaming = true;
      (h.core as unknown as { onPerception(kind: string, intensity: number): void }).onPerception("message", 1);
      expect(h.steered).toHaveLength(0);
      expect(h.timers.size).toBe(0);
      h.agent.state.isStreaming = false;
      (h.core as unknown as { onRunEnd(reason: string): void }).onRunEnd("turn");
      // 无限循环:这一轮结束立刻排下一轮,中间没有心跳间隔
      expect([...h.timers.values()][0]?.at).toBe(0);
    } finally {
      h.storage.close();
    }
  });
});

describe("体感注入", () => {
  it("管理器允许再次注入时,同种同档体感不会被永久去重", () => {
    const storage = repo();
    try {
      const injector = new Injector(() => "openai-completions", storage, () => 0);
      expect(injector.queueFeeling("drowsy", 1)).toBe(true);
      injector.drain();
      expect(injector.queueFeeling("drowsy", 1)).toBe(true);
      expect(injector.pendingCount).toBe(1);
    } finally {
      storage.close();
    }
  });
});
