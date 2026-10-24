import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "typebox";
import { fmtSim, HOUR, MIN, type SimClock } from "./clock.js";
import { toolCopy } from "./copy.js";
import type { SleepMachine } from "./machine.js";
import type { Repo } from "../store/db.js";

export interface CoreToolsHost {
  clock: SimClock;
  machine: SleepMachine;
  repo: Repo;
  /** 排程一次未来的 kick(模拟时间) */
  scheduleKickIn(simMs: number, reason: string): void;
  log(msg: string): void;
}

/**
 * 核心内置工具:睡眠、起床、等待、闹钟、看时间。
 * 起床/入睡都只是工具 —— 模型自己决定调不调,循环永不被打断式询问。
 */
export function buildCoreTools(host: CoreToolsHost): AgentTool<any>[] {
  const { clock, machine, repo } = host;

  const waitParams = Type.Object({
    minutes: Type.Number({ description: "等待多少分钟(模拟时间),1-720", minimum: 1, maximum: 720 }),
  });
  const waitTool: AgentTool<typeof waitParams> = {
    name: "wait",
    label: "发呆等待",
    description:
      "什么都不做,安静地度过一段时间(模拟时间)。没事做、想放空、或者单纯想让时间流过去时调用。",
    parameters: waitParams,
    execute: async (_id, params: Static<typeof waitParams>) => {
      const minutes = Math.round(params.minutes);
      host.scheduleKickIn(minutes * MIN, `wait:${minutes}m`);
      return { content: [{ type: "text", text: toolCopy.waited(minutes) }], details: { minutes } };
    },
  };

  const emptyParams = Type.Object({});
  const sleepTool: AgentTool<typeof emptyParams> = {
    name: "sleep",
    label: "入睡",
    description: "去睡觉。你会先在睡梦中整理今天的记忆,然后沉沉睡去,直到自然醒、闹钟或别的什么把你叫醒。",
    parameters: emptyParams,
    execute: async () => {
      const msg = await machine.sleepVoluntarily();
      return { content: [{ type: "text", text: msg }], details: { slept: true }, terminate: true };
    },
  };

  const wakeUpTool: AgentTool<typeof emptyParams> = {
    name: "wake_up",
    label: "起床",
    description: "从床上起来,彻底清醒。只有在被人从睡梦中叫醒、闹钟响了你决定起的时候才需要调用;自然醒不需要。",
    parameters: emptyParams,
    execute: async () => {
      machine.confirmWake();
      return { content: [{ type: "text", text: toolCopy.wakeConfirmed }], details: { woke: true }, terminate: true };
    },
  };

  const alarmParams = Type.Object({
    time: Type.String({ description: '24小时制时刻,如 "07:30"' }),
    note: Type.Optional(Type.String({ description: '闹钟备注,比如"要去拿快递"' })),
  });
  const setAlarmTool: AgentTool<typeof alarmParams> = {
    name: "set_alarm",
    label: "设闹钟",
    description: "给自己定一个起床闹钟。时间到达时会把你吵醒;如果你不起,它会每隔几分钟重响一次。",
    parameters: alarmParams,
    execute: async (_id, params: Static<typeof alarmParams>) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(params.time.trim());
      if (!m) throw new Error(`无法解析时刻: ${params.time}`);
      const hh = Math.min(23, parseInt(m[1]!, 10));
      const mm = Math.min(59, parseInt(m[2]!, 10));
      const now = new Date(clock.simNow());
      const due = new Date(now);
      due.setHours(hh, mm, 0, 0);
      if (due.getTime() <= now.getTime()) due.setTime(due.getTime() + 24 * HOUR);
      const id = repo.addAlarm(due.getTime(), clock.simNow(), "agent", params.note);
      host.log(`[alarm] #${id} 定在 ${fmtSim(due.getTime())} (${params.note ?? ""})`);
      return {
        content: [{ type: "text", text: toolCopy.alarmSet(params.time) }],
        details: { alarmId: id, dueSim: due.getTime() },
      };
    },
  };

  const cancelParams = Type.Object({
    alarmId: Type.Optional(Type.Number({ description: "set_alarm 返回的闹钟 id;省略则取消全部" })),
  });
  const cancelAlarmTool: AgentTool<typeof cancelParams> = {
    name: "cancel_alarm",
    label: "取消闹钟",
    description: "取消自己设的、还没响的闹钟。不带参数时取消全部。",
    parameters: cancelParams,
    execute: async (_id, params: Static<typeof cancelParams>) => {
      const pend = repo.duePendingAlarms(Number.MAX_SAFE_INTEGER);
      let n = 0;
      for (const a of pend) {
        if (params.alarmId == null || a.id === params.alarmId) {
          repo.markAlarm(a.id, "cancelled");
          n++;
        }
      }
      return {
        content: [{ type: "text", text: toolCopy.alarmCancelled }],
        details: { cancelled: n },
      };
    },
  };

  const timeTool: AgentTool<typeof emptyParams> = {
    name: "what_time_is_it",
    label: "看时间",
    description: "看看现在几点,今天几号星期几。",
    parameters: emptyParams,
    execute: async () => {
      const d = clock.simDate();
      const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
      return {
        content: [{ type: "text", text: `现在是 ${fmtSim(clock.simNow())},星期${week}。` }],
        details: { sim: clock.simNow() },
      };
    },
  };

  return [waitTool, sleepTool, wakeUpTool, setAlarmTool, cancelAlarmTool, timeTool];
}
