import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type { CoreEvent, Emitter } from "../core/events.js";
import type { StateManager } from "./manager.js";

export interface JudgeDeps {
  /** judge.enabled=false 时不注册监听、不调用模型 */
  enabled: boolean;
  events: Emitter<CoreEvent>;
  manager: StateManager;
  /** 每次调用时取当前模型/流函数/密钥(支持面板热切换模型) */
  getModel(): Model<any>;
  getStreamFn(): StreamFn;
  getApiKey(): string | undefined;
  /** 人设文本:判读必须以角色人设为锚,防止情绪修正 OOC */
  getPersona(): string;
  /** 每次判读调用的 token 用量(面板统计) */
  onUsage?(usage: unknown, message: { model?: string; provider?: string }): void;
  /** 最近对话文本(监控 agent 本体,与模块无关) */
  recentTranscript(): string;
  log?(msg: string): void;
}

/**
 * 双通道 LLM 情绪修正之「实时通道」:
 * 启发式规则只负责发现高唤醒事件(被@风暴、闹钟连环),
 * 判读交给一次廉价 LLM 调用,输出 {moodDelta, stressDelta} 交给 manager 应用
 * (manager 侧另有开关、冷却与每日上限,双保险)。
 * 「睡眠通道」在 memory/consolidation 的 adjust_mood 工具,复用睡眠总结,零额外调用。
 */
export class Judge {
  private busy = false;

  constructor(private readonly deps: JudgeDeps) {}

  get enabled(): boolean {
    return this.deps.enabled;
  }

  start(): void {
    if (!this.deps.enabled) {
      this.deps.log?.("[judge] 已关闭(enabled=false),不注册实时通道");
      return;
    }
    this.deps.events.on((e) => {
      if (this.busy) return;
      const flagged =
        (e.type === "perception" && e.kind === "mention_storm" && e.intensity >= 3) ||
        e.type === "alarm_rang";
      if (flagged) void this.evaluate();
    });
  }

  /** 也可由外部(面板)手动触发评估 */
  async evaluate(): Promise<void> {
    if (!this.deps.enabled || this.busy) return;
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
        `${this.deps.getPersona()}\n\n` +
        `【你的任务】你是上面这个角色的情绪判读模块。根据最近的对话/事件片段,判断这段经历对「这个角色」的情绪影响。\n` +
        `判读必须以人设为锚:同一件事,不同性格的角色反应完全不同(例如人设里讨厌被吵醒,被吵醒的烦躁与心情下降就该更重;人设慢热,陌生人的示好就不该大幅提升心情)。` +
        `凡是不符合人设的情绪反应都算 OOC,必须修正到「这个角色应有的反应」。\n\n` +
        `只输出 JSON:{"moodDelta": -20..20 整数, "stressDelta": 0..20 整数, "reason": "一句话(说明为什么符合人设)"}。` +
        `平淡或人设反应中性则输出 {"moodDelta":0,"stressDelta":0,"reason":"平淡"}。不要输出其他任何内容。`,
      messages: [
        {
          role: "user",
          content: transcript.slice(-4000),
          timestamp: Date.now(),
        },
      ] as AgentMessage[],
      tools: [],
    };
    const stream = await this.deps.getStreamFn()(this.deps.getModel() as never, context as never, {
      apiKey: this.deps.getApiKey(),
    });
    const message = await stream.result();
    this.deps.onUsage?.((message as { usage?: unknown }).usage, {
      model: (message as { model?: string }).model,
      provider: (message as { provider?: string }).provider,
    });
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
