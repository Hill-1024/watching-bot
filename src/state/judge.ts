import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { CoreEvent, Emitter } from "../core/events.js";
import type { StateManager } from "./manager.js";

export interface JudgeDeps {
  events: Emitter<CoreEvent>;
  manager: StateManager;
  model: Model<any>;
  streamFn: StreamFn;
  apiKey: string;
  /** 最近对话文本(监控 agent 本体,与模块无关) */
  recentTranscript(): string;
  log?(msg: string): void;
}

/**
 * 双通道 LLM 情绪修正之「实时通道」:
 * 启发式规则只负责发现高唤醒事件(被@风暴、闹钟连环、激烈对话关键词),
 * 判读交给一次廉价 LLM 调用,输出 {moodDelta, stressDelta} 交给 manager 应用
 * (manager 侧另有冷却与每日上限,双保险)。
 * 「睡眠通道」在 memory/consolidation 的 adjust_mood 工具,复用睡眠总结,零额外调用。
 */
const AROUSAL_PATTERNS: RegExp[] = [
  /吵架|滚|闭嘴|拉黑|绝交|烦死了| SB |傻逼/i,
  /喜欢你|爱你|表白|生日快乐|恭喜|抱抱/,
  /急|快回|紧急|出事了|救命/,
];

export class Judge {
  private busy = false;

  constructor(private readonly deps: JudgeDeps) {}

  start(): void {
    this.deps.events.on((e) => {
      if (this.busy) return;
      let flagged = false;
      if (e.type === "perception" && e.kind === "mention_storm" && e.intensity >= 3) flagged = true;
      if (e.type === "alarm_rang") flagged = true;
      if (flagged) void this.evaluate();
    });
    // 激烈对话关键词:扫 transcript 由 tick 周期驱动,避免每条消息都扫
  }

  /** 也可由外部(面板)手动触发评估 */
  async evaluate(): Promise<void> {
    if (this.busy) return;
    const transcript = this.deps.recentTranscript();
    if (!transcript) return;
    this.busy = true;
    try {
      const result = await this.askLlm(transcript);
      if (result) {
        this.deps.manager.applyJudgeCorrection(result.moodDelta, result.stressDelta);
        this.deps.log?.(`[judge] 修正 mood${result.moodDelta >= 0 ? "+" : ""}${result.moodDelta} stress${result.stressDelta >= 0 ? "+" : ""}${result.stressDelta}(${result.reason})`);
      }
    } catch (err) {
      this.deps.log?.(`[judge] 评估失败: ${String(err)}`);
    } finally {
      this.busy = false;
    }
  }

  private async askLlm(transcript: string): Promise<{ moodDelta: number; stressDelta: number; reason: string } | null> {
    const context = {
      systemPrompt:
        "你是拟人 agent 的情绪判读模块。根据最近的对话/事件片段,判断这段经历对角色情绪的影响。只输出 JSON:{\"moodDelta\": -20..20 整数, \"stressDelta\": 0..20 整数, \"reason\": \"一句话\"}。平淡则输出 {\"moodDelta\":0,\"stressDelta\":0,\"reason\":\"平淡\"}。不要输出其他任何内容。",
      messages: [
        {
          role: "user",
          content: transcript.slice(-4000),
          timestamp: Date.now(),
        },
      ] as AgentMessage[],
      tools: [],
    };
    const stream = await this.deps.streamFn(this.deps.model as never, context as never, { apiKey: this.deps.apiKey });
    const message = await stream.result();
    const text = ((message.content as { type: string; text?: string }[]) ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as { moodDelta?: number; stressDelta?: number; reason?: string };
      const moodDelta = Math.max(-20, Math.min(20, Math.round(parsed.moodDelta ?? 0)));
      const stressDelta = Math.max(0, Math.min(20, Math.round(parsed.stressDelta ?? 0)));
      if (moodDelta === 0 && stressDelta === 0) return null;
      return { moodDelta, stressDelta, reason: parsed.reason ?? "" };
    } catch {
      return null;
    }
  }
}
