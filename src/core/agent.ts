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
 * 硬性上下文裁剪:token 估算管不到「JSON 节点数」。
 * 一些 OpenAI 兼容网关限制请求体的 JSON 节点数(如 32768),几千条消息历史就会超,
 * 而 token 估算可能还远低于窗口阈值 —— 此时 compaction 不会触发,请求直接 400。
 * 这里按消息条数设硬上限,并在 user 边界切(避免留下孤儿 toolResult)。
 */
function trimForProtocol(messages: AgentMessage[], maxMessages: number): AgentMessage[] {
  if (messages.length <= maxMessages) return messages;
  // 开头连续的 system(通常只有一条人设)始终保留
  let prefixEnd = 0;
  while (prefixEnd < messages.length && (messages[prefixEnd] as { role?: string }).role === "system") prefixEnd++;
  const prefix = messages.slice(0, prefixEnd);
  let start = messages.length - maxMessages;
  // 向前找到 user 消息作为切点:一次 kick 以 user 消息开始,后面才是 assistant/toolResult
  while (start < messages.length && (messages[start] as { role?: string }).role !== "user") start++;
  if (start >= messages.length || start <= prefixEnd) return messages;
  const omitted = start - prefixEnd;
  return [
    ...prefix,
    {
      role: "user" as const,
      content: `[为控制上下文体积,更早的 ${omitted} 条对话已省略;需要长期信息时看 MEMORY.md 与日记。]`,
      timestamp: Date.now(),
    },
    ...messages.slice(start),
  ];
}

export interface AgentAssembly {
  agent: Agent;
}

/**
 * pi Agent 装配:
 * - 系统提示 = persona + 各 section(memory/capabilities/inner),section 可后续热更新
 * - convertToLlm 直通(只用标准角色)
 * - transformContext:上下文接近窗口时,用 pi coding-agent 导出的 compaction 纯函数
 *   (shouldCompact/estimateContextTokens/generateSummaryWithUsage)做摘要压缩,旧消息折叠为一条摘要
 */
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
      tools: opts.tools,
      messages: initialMessages,
    },
    convertToLlm: toLlmMessages,
    streamFn: opts.streamFn,
    transformContext: async (messages) => {
      // 先做 JSON 节点数保护:几千条历史会让网关直接 400,且 token 估算发现不了
      const maxMessages = Math.max(160, opts.loopCfg.hotTailMessages * 4);
      const trimmed = trimForProtocol(messages, maxMessages);
      const tokens = trimmed.reduce((n, m) => n + estimateTokens(m), 0);
      const contextWindow = typeof opts.contextWindow === "function"
        ? opts.contextWindow()
        : opts.contextWindow;
      if (!shouldCompact(tokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)) {
        return trimmed;
      }
      // 找切点:从尾往前保留 ~keepRecentTokens,切在消息边界(非 system)
      const keepTokens = DEFAULT_COMPACTION_SETTINGS.keepRecentTokens;
      let cut = trimmed.length;
      let acc = 0;
      for (let i = trimmed.length - 1; i >= 1; i--) {
        const m = trimmed[i]!;
        if (m.role === "system") break;
        acc += roughTokens(m);
        cut = i;
        if (acc >= keepTokens) break;
      }
      if (cut <= 1) return trimmed;
      const toSummarize = trimmed.slice(1, cut);
      log(`[compaction] 上下文 ${tokens} tokens 超限,压缩 ${toSummarize.length} 条旧消息`);
      try {
        const summary = await opts.summarize(toSummarize);
        const summaryMsg = {
          role: "user" as const,
          content: `${COMPACTION_SUMMARY_PLACEHOLDER}${summary}`,
          timestamp: Date.now(),
        };
        return [trimmed[0]!, summaryMsg, ...trimmed.slice(cut)];
      } catch (err) {
        log(`[compaction] 压缩失败,本次跳过: ${String(err)}`);
        return trimmed;
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
