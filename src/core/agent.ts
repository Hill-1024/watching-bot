import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateTokens,
  generateSummaryWithUsage,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { LoopConfig } from "../config.js";
import { COMPACTION_SUMMARY_PLACEHOLDER } from "./compaction-consts.js";

const LLM_ROLES = new Set(["system", "user", "assistant", "toolResult"]);

/** 只把标准角色消息交给 LLM(pi-coding-agent 的声明合并会给 AgentMessage 加自定义类型) */
function toLlmMessages(messages: AgentMessage[]): Message[] {
  return messages.filter((m) => LLM_ROLES.has((m as { role?: string }).role ?? "")) as Message[];
}

export { toLlmMessages };

/**
 * 工具输出在**产生时**裁剪一次:裁剪后的结果进入历史,之后不再改写,
 * 因此不会移动历史前缀、不会破坏 prompt cache;上下文长度本身交给 pi 的 compaction。
 * 模型需要更多信息时,可以用更精确的参数重新查询。
 */
const MAX_TOOL_TEXT_CHARS = 8_000;

export function capToolResultContent(content: unknown[]): unknown[] {
  let remaining = MAX_TOOL_TEXT_CHARS;
  let omitted = 0;
  const out: unknown[] = [];
  for (const part of content as { type?: string; text?: string }[]) {
    if (part?.type === "text" && typeof part.text === "string") {
      if (part.text.length <= remaining) {
        remaining -= part.text.length;
        out.push(part);
      } else {
        const keep = remaining;
        omitted += part.text.length - keep;
        if (keep > 0) out.push({ ...part, text: part.text.slice(0, keep) });
        remaining = 0;
      }
    } else {
      out.push(part);
    }
  }
  if (omitted > 0) {
    out.push({ type: "text", text: `[输出过长,已省略 ${omitted} 字;需要更多信息请用更精确的参数重新查询]` });
  }
  return out;
}

/** 给每个工具包一层:单次返回的文本超过上限时截断(只做一次,历史保持稳定) */
export function capTools(tools: AgentTool[]): AgentTool[] {
  return tools.map((tool) => {
    const original = tool.execute;
    if (typeof original !== "function") return tool;
    return {
      ...tool,
      execute: async (...args: unknown[]) => {
        const result = (await (original as (...a: unknown[]) => Promise<unknown>)(...args)) as { content?: unknown } & Record<string, unknown>;
        if (!result || !Array.isArray(result.content)) return result;
        return { ...result, content: capToolResultContent(result.content) };
      },
    } as unknown as AgentTool;
  });
}


export interface AgentAssembly {
  agent: Agent;
}

export function createAgent(opts: {
  model: Model<any>;
  streamFn: StreamFn;
  /** 基础人设文本(persona.md) */
  systemPrompt: string;
  /** 命名 sections:memory/capabilities/instructions 等,可被后续 system 消息热更新 */
  sections: Record<string, string | null>;
  tools: AgentTool[];
  /** 恢复的 transcript(不含 leading system 消息) */
  restoredMessages?: import("@earendil-works/pi-agent-core").AgentMessage[];
  loopCfg: LoopConfig;
  /** 当前模型上下文窗口;传 getter 可在模型热切换后立即生效 */
  contextWindow: number | (() => number);
  summarize: (messages: import("@earendil-works/pi-agent-core").AgentMessage[]) => Promise<string>;
  log?: (msg: string) => void;
}): AgentAssembly {
  const log = opts.log ?? (() => {});
  const leadingSystem: import("@earendil-works/pi-agent-core").AgentMessage = {
    role: "system",
    content: opts.systemPrompt,
    sections: opts.sections,
    timestamp: Date.now(),
  };
  const initialMessages = [leadingSystem, ...(opts.restoredMessages ?? [])];
  const agent = new Agent({
    initialState: {
      model: opts.model,
      thinkingLevel: "off",
      tools: capTools(opts.tools),
      messages: initialMessages,
    },
    convertToLlm: toLlmMessages,
    streamFn: opts.streamFn,
    transformContext: async (messages) => {
      // 上下文长度交给 pi 的 compaction:不做滑动窗口/条数裁剪(会移动历史前缀、
      // 让 prompt cache 全部失效)。工具输出的体积在产生时(CapTools)就已经限制过。
      const tokens = messages.reduce((n, m) => n + estimateTokens(m), 0);
      const contextWindow = typeof opts.contextWindow === "function"
        ? opts.contextWindow()
        : opts.contextWindow;
      if (!shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
        return messages;
      }
      // 找切点:从尾往前保留 ~keepRecentTokens,切在消息边界(非 system)
      const keepTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
      let cut = messages.length;
      let acc = 0;
      for (let i = messages.length - 1; i >= 1; i--) {
        const m = messages[i]!;
        if (m.role === "system") break;
        acc += roughTokens(m);
        cut = i;
        if (acc >= keepTokens) break;
      }
      if (cut <= 1) return messages;
      const toSummarize = messages.slice(1, cut);
      log(`[compaction] 上下文 ${tokens} tokens 超限,压缩 ${toSummarize.length} 条旧消息`);
      try {
        const summary = await opts.summarize(toSummarize);
        const summaryMsg = {
          role: "user" as const,
          content: `${COMPACTION_SUMMARY_PLACEHOLDER}${summary}`,
          timestamp: Date.now(),
        };
        return [messages[0]!, summaryMsg, ...messages.slice(cut)];
      } catch (err) {
        log(`[compaction] 压缩失败,本次跳过: ${String(err)}`);
        return messages;
      }
    },
  });
  return { agent };
}

/** 粗估 tokens:优先用 pi 的 estimateTokens,失败退固定值 */
function roughTokens(m: unknown): number {
  try {
    return estimateTokens(m as AgentMessage);
  } catch {
    return 32;
  }
}

export type { LoopConfig };
