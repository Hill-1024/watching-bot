import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  streamSimple as compatStreamSimple,
} from "@earendil-works/pi-ai/compat";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/compat";

/**
 * faux LLM:无 API key 的全链路测试剧本。
 * registerFauxProvider 是 pi 自带的假 provider;这里装一个「会睡觉会赖床」的规则脚本,
 * 覆盖 M1/M2 的睡醒闭环:困了睡、闹钟响赖一次床再起、风暴吵醒、没事 wait。
 * 启用方式:环境变量 WATCHING_BOT_FAUX_LLM=1
 */
export interface FauxHandles {
  model: Model<string>;
  streamFn: StreamFn;
}

export function installFauxLlm(): FauxHandles {
  const reg = registerFauxProvider({
    models: [{ id: "faux-persona", name: "faux-persona", contextWindow: 128000, maxTokens: 4096 }],
  });

  let step = 0;
  const script: FauxResponseFactory = (context: TranscriptContext) => {
      step++;
      const tail = recentText(context, 30).join("\n");
      const lastKind = lastLineKind(context);

      // 睡眠期归并场景:依次写日记 → 更新索引 → finish
      if (tail.includes("睡梦整理")) {
        if (!tail.includes("日记已收好")) {
          return fauxAssistantMessage([
            fauxToolCall("write_diary", { content: "今天过得平淡,和朋友们有一搭没一搭地聊了几句。" }),
          ]);
        }
        if (!tail.includes("记忆索引已更新")) {
          return fauxAssistantMessage([
            fauxToolCall(
              "update_memory_index",
              {
                content:
                  "# MEMORY.md — 长期记忆索引\n\n## 长期事实\n\n## 日记索引\n- (faux)今日:平淡的一天\n",
              },
            ),
          ]);
        }
        return fauxAssistantMessage([fauxToolCall("finish", { summary: "记住了平淡的一天" })]);
      }

      // 周归并场景
      if (tail.includes("旧日记")) {
        return fauxAssistantMessage([
          fauxToolCall("save_week_merge", { content: "这周总体平淡,没什么大事。" }),
        ]);
      }

      // napcat 链路:感知到消息 → 看会话 → 读 → 回 → 已读(一次一条链)
      if (/(手机震了一下|好像有人在叫你)/.test(tail)) {
        const lastResult = lastToolResultText(context);
        // 链路里看到图 → 先收藏成表情包
        if (/\[图片[^\]]*\][^\n]*\(id:(\d+)\)/.test(lastResult) && !tail.includes("已收藏为表情包")) {
          const mid = Number(/\[图片[^\]]*\][^\n]*\(id:(\d+)\)/.exec(lastResult)![1]!);
          return fauxAssistantMessage([fauxToolCall("save_meme_from_message", { messageId: mid, name: "测试梗图" })]);
        }
        if (tail.includes("已收藏为表情包「测试梗图」") && !tail.includes("表情包「测试梗图」发出去了")) {
          return fauxAssistantMessage([
            fauxToolCall("send_meme", { chat: "group:30001", memeName: "测试梗图", caption: "哈哈这张绝了" }),
          ]);
        }
        if (!lastResult) return fauxAssistantMessage([fauxToolCall("list_chats", {})]);
        if (lastResult.includes("[group:") || lastResult.includes("[private:")) {
          return fauxAssistantMessage([fauxToolCall("read_messages", { chat: "group:30001", n: 10 })]);
        }
        if (lastResult.startsWith("[2") || lastResult.includes("] ")) {
          // 读到了消息:引用回复第一条(id 取 read 输出第一行)
          const idm = /\(id:(\d+)\)/.exec(lastResult);
          if (idm && !tail.includes("回复发出去了")) {
            return fauxAssistantMessage([
              fauxToolCall("send_message", { chat: "group:30001", text: "看到了看到了,这就来。", replyTo: Number(idm[1]!) }),
            ]);
          }
          return fauxAssistantMessage([fauxToolCall("send_message", { chat: "group:30001", text: "看到了看到了,这就来。" })]);
        }
        if (lastResult.includes("发出去了")) {
          return fauxAssistantMessage([fauxToolCall("mark_read", { chat: "group:30001" })]);
        }
        return fauxAssistantMessage([fauxToolCall("list_chats", {})]);
      }

      // 工具结果之后:简短确认,让 run 自然结束
      if (lastKind === "toolResult") {
        return fauxAssistantMessage([fauxText("……")]);
      }

      // 刚被叫醒(闹钟/风暴):赖一两次床,然后起
      if (/闹钟|@你|震动/.test(tail)) {
        const wakeUps = countOf(tail, "你彻底醒了");
        const snoozes = countOf(tail, "翻了个身");
        if (wakeUps === 0 && snoozes <= 1) {
          return fauxAssistantMessage([fauxText("……(翻了个身,把闹钟按掉)再睡一会儿……")]);
        }
        return fauxAssistantMessage([fauxToolCall("wake_up", {})]);
      }

      // 自然醒/硬上限之后:发会儿呆
      if (/自然醒了|弹醒了/.test(tail)) {
        return fauxAssistantMessage([fauxToolCall("wait", { minutes: 30 })]);
      }

      // 困意到顶(tier3 体感)→ 自愿去睡
      if (/撑不住|必须睡|断片/.test(tail)) {
        return fauxAssistantMessage([fauxToolCall("sleep", {})]);
      }

      // 平时:wait,证明循环链路
      return fauxAssistantMessage([fauxToolCall("wait", { minutes: 45 })]);
  };

  reg.setResponses([script]);
  const model = reg.getModel() as Model<string>;
  // faux 的 responses 队列是一次性的(用完即报 No more faux responses queued),
  // 这里在每次请求前把常驻剧本补回队列,让它变成可无限应答的规则脚本。
  const streamFn: StreamFn = (m, context, options) => {
    if (reg.getPendingResponseCount() === 0) reg.setResponses([script]);
    return compatStreamSimple(m as never, context, options);
  };
  return { model, streamFn };
}

function recentText(context: TranscriptContext, n: number): string[] {
  const msgs = context.messages.slice(-n);
  const out: string[] = [];
  for (const m of msgs) {
    const mm = m as { role?: string; content?: unknown };
    if (typeof mm.content === "string") out.push(mm.content);
    else if (Array.isArray(mm.content)) {
      for (const part of mm.content as { type?: string; text?: string }[]) {
        if (part?.type === "text" && part.text) out.push(part.text);
      }
    }
  }
  return out;
}

function lastLineKind(context: TranscriptContext): string {
  const msgs = context.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string };
    if (m?.role === "user") return "user";
    if (m?.role === "toolResult") return "toolResult";
    if (m?.role === "assistant") return "assistant";
  }
  return "user";
}

/** 最近一条工具结果的文本(用于剧本链) */
function lastToolResultText(context: TranscriptContext): string {
  const msgs = context.messages;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: string; content?: unknown };
    if (m?.role === "toolResult" && Array.isArray(m.content)) {
      return (m.content as { type?: string; text?: string }[])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join(" ");
    }
    if (m?.role === "user") return "";
  }
  return "";
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    n++;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return n;
}
