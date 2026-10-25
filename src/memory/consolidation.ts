import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Model } from "@earendil-works/pi-ai";
import type { MemoryStore } from "./files.js";
import { fmtSim } from "../core/clock.js";
import { toLlmMessages } from "../core/agent.js";

/**
 * 睡眠期长期记忆归并(我们设计的那部分,与 pi 日常 compaction 分工):
 * 模型在睡梦中一次性完成 ——
 *  1. 写今天的日记 memories/YYYY-MM-DD.md
 *  2. 把新长期事实合并进 MEMORY.md 索引(去重、归档过期条目)
 * 日记攒够一周后追加一次周归并:7 篇日记 → memories/YYYY-Www.md。
 */
export interface ConsolidationDeps {
  model: Model<any>;
  streamFn: StreamFn;
  memory: MemoryStore;
  /** 攒满几篇日记做一次周归并 */
  weekSize?: number;
  /** 睡眠通道情绪修正:模型在睡前回顾时可对今天做一次心情/压力结算 */
  onSleepCorrection?: (moodDelta: number, stressDelta: number, reason: string) => void;
  /** 每次模型调用的 token 用量(面板统计) */
  onUsage?: (
    usage: unknown,
    message: { model?: string; provider?: string },
    source?: "memory" | "weekly",
  ) => void;
  /** 人设文本:adjust_mood 情绪结算必须以人设为锚,防 OOC */
  persona?: string;
  log?(msg: string): void;
}

export function transcriptToText(messages: AgentMessage[], maxChars = 60_000): string {
  const lines: string[] = [];
  for (const m of messages) {
    const mm = m as { role?: string; content?: unknown };
    if (mm.role === "user" && typeof mm.content === "string") {
      lines.push(`[旁白/输入] ${mm.content}`);
    } else if (mm.role === "assistant" && Array.isArray(mm.content)) {
      for (const part of mm.content as { type: string; text?: string; name?: string; arguments?: unknown }[]) {
        if (part.type === "text" && part.text) lines.push(`[我] ${part.text}`);
        else if (part.type === "toolCall") lines.push(`[我·动作] ${part.name}(${JSON.stringify(part.arguments ?? {})})`);
      }
    } else if (mm.role === "toolResult" && Array.isArray(mm.content)) {
      for (const part of mm.content as { type: string; text?: string }[]) {
        if (part.type === "text" && part.text) lines.push(`[结果] ${part.text}`);
      }
    }
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return text;
}

export async function runConsolidation(deps: ConsolidationDeps, transcript: AgentMessage[], simNow: number): Promise<void> {
  const log = deps.log ?? (() => {});
  const memory = deps.memory;
  const today = new Date(simNow).toISOString().slice(0, 10);
  const simTime = fmtSim(simNow);

  let writeCalls = 0;
  const written: string[] = [];

  const writeDiary: AgentTool<any> = {
    name: "write_diary",
    label: "写日记",
    description: "把今天值得记住的事写成当天的日记。只写过了今天就不再明显的细节感受与事件。",
    parameters: Type.Object({
      content: Type.String({ description: "日记正文(markdown)" }),
    }),
    execute: async (_id, params: any) => {
      memory.writeDiary(today, `# ${today} 日记\n\n${params.content}\n`);
      writeCalls++;
      written.push(`diary:${today}`);
      return { content: [{ type: "text", text: "日记已收好。" }], details: {} };
    },
  };

  const updateIndex: AgentTool<any> = {
    name: "update_memory_index",
    label: "整理长期记忆",
    description:
      "重写 MEMORY.md 长期记忆索引:从今天经历中提炼「长期该记得的事实」(人物、关系、约定、偏好)合并进「长期事实」区(去重、删过时条目);并在「日记索引」区补上今天一行。整个文件内容都会被你提供的文本替换。",
    parameters: Type.Object({
      content: Type.String({ description: "MEMORY.md 完整新内容(markdown)" }),
    }),
    execute: async (_id, params: any) => {
      memory.writeIndex(params.content);
      writeCalls++;
      written.push("index");
      return { content: [{ type: "text", text: "记忆索引已更新。" }], details: {} };
    },
  };

  const adjustMood: AgentTool<any> = {
    name: "adjust_mood",
    label: "给今天的心情结算",
    description:
      "回顾完今天后,给这一天的整体经历一个情绪结算(可选,平静的一天可以不调):冲突/不愉快给负 moodDelta,开心的事给正;压力大给 stressDelta。",
    parameters: Type.Object({
      moodDelta: Type.Number({ description: "-20..20" }),
      stressDelta: Type.Number({ description: "0..20" }),
      reason: Type.String({ description: "一句话原因" }),
    }),
    execute: async (_id, params: any) => {
      deps.onSleepCorrection?.(
        Math.max(-20, Math.min(20, Math.round(params.moodDelta))),
        Math.max(0, Math.min(20, Math.round(params.stressDelta))),
        String(params.reason ?? ""),
      );
      return { content: [{ type: "text", text: "结算完成。" }], details: {} };
    },
  };

  const finish: AgentTool<any> = {
    name: "finish",
    label: "整理完毕",
    description: "记忆整理完成,安心睡去。",
    parameters: Type.Object({
      summary: Type.String({ description: "一句话:今天记住了什么" }),
    }),
    execute: async (_id, params: any) => {
      log(`[memory] 归并完成: ${params.summary}`);
      return { content: [{ type: "text", text: "晚安。" }], details: {}, terminate: true };
    },
  };

  const recentDiaries = memory.recentDiaries(7, today);
  const personaAnchor = deps.persona
    ? `\n\n【你的人设(情绪结算时以此为锚,结算必须符合这个角色应有的反应,否则就是 OOC)】\n${deps.persona}`
    : "";
  const systemPrompt = `你在睡梦中半梦半醒。现在是 ${simTime}(刚躺下)。你的任务是睡前整理记忆:
1. 用 write_diary 把今天的经历写成日记(基于下面给你的今日对话记录);
2. 用 update_memory_index 把值得长期记住的事实合并进 MEMORY.md;
3. 如果今天情绪起伏明显,用 adjust_mood 结算心情(平静的一天可跳过;结算量必须符合你的人设);
4. 用 finish 结束。做完就睡。${personaAnchor}`;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: deps.model,
      thinkingLevel: "off",
      tools: [writeDiary, updateIndex, adjustMood, finish],
    },
    convertToLlm: toLlmMessages,
    streamFn: deps.streamFn,
  });
  agent.subscribe((event) => {
    if (event.type === "message_end") {
      const m = event.message as {
        role?: string;
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
        usage?: unknown;
        model?: string;
        provider?: string;
      };
      if (m.role === "assistant") {
        deps.onUsage?.(m.usage, { model: m.model, provider: m.provider }, "memory");
        log(`[memory:debug] assistant stop=${m.stopReason} err=${m.errorMessage ?? "-"} content=${JSON.stringify(m.content)?.slice(0, 300)}`);
      }
    } else if (event.type === "tool_execution_end") {
      log(`[memory:debug] tool ${event.toolName} isError=${event.isError}`);
    }
  });

  const recentDiaryText = recentDiaries.length
    ? `\n\n[最近的日记]\n${recentDiaries.map((d) => `--- ${d.date} ---\n${d.text}`).join("\n")}`
    : "";
  const currentIndex = memory.indexText();

  await agent.prompt({
    role: "user",
    content: `[睡梦整理] 以下是今天的对话记录:\n\n${transcriptToText(transcript)}\n\n[当前 MEMORY.md]\n${currentIndex}${recentDiaryText}\n\n请开始整理。`,
    timestamp: Date.now(),
  });
  await agent.waitForIdle();

  if (writeCalls === 0) {
    log("[memory] 模型没有写入任何记忆,跳过周归并");
    return;
  }
  await maybeWeeklyMerge(deps, today, simNow);
}

/** 周归并:同一 ISO 周攒满 N 篇日记 → 合并为 memories/YYYY-Wnn.md */
async function maybeWeeklyMerge(deps: ConsolidationDeps, today: string, simNow: number): Promise<void> {
  const log = deps.log ?? (() => {});
  const memory = deps.memory;
  const dates = memory.listDiaryDates().filter((d) => d !== today);
  if (dates.length < (deps.weekSize ?? 7)) {
    return;
  }
  // 取最早的 N 篇(同周优先:简单起见取最早的 N 篇)
  const batch = dates.slice(0, deps.weekSize ?? 7);
  const texts = batch.map((d) => ({ date: d, text: memory.readDiary(d) ?? "" }));
  const first = new Date(batch[0]!);
  const week = isoWeek(first);
  const weekName = `${first.getFullYear()}-W${String(week).padStart(2, "0")}`;

  const mergeTool: AgentTool<any> = {
    name: "save_week_merge",
    label: "保存周归并",
    description: "把这几篇日记合并成一份周记。",
    parameters: Type.Object({ content: Type.String({ description: "周记正文(markdown)" }) }),
    execute: async (_id, params: any) => {
      memory.mergeDiariesToWeek(weekName, batch, `# ${weekName} 周记\n\n${params.content}\n`);
      return { content: [{ type: "text", text: "已归档。" }], details: {} };
    },
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: `你在睡梦中整理旧日记。把 ${batch.length} 篇日记合并成一份周记:保留仍然有意义的事,压缩流水账。只调用 save_week_merge 一次。`,
      model: deps.model,
      thinkingLevel: "off",
      tools: [mergeTool],
    },
    convertToLlm: toLlmMessages,
    streamFn: deps.streamFn,
  });
  agent.subscribe((event) => {
    if (event.type !== "message_end") return;
    const m = event.message as {
      role?: string;
      usage?: unknown;
      model?: string;
      provider?: string;
    };
    if (m.role === "assistant") deps.onUsage?.(m.usage, { model: m.model, provider: m.provider }, "weekly");
  });
  await agent.prompt({
    role: "user",
    content: texts.map((t) => `--- ${t.date} ---\n${t.text}`).join("\n\n"),
    timestamp: Date.now(),
  });
  await agent.waitForIdle();
  log(`[memory] 周归并 ${batch.join(",")} → ${weekName} @sim ${fmtSim(simNow)}`);
}

function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
