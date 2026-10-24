import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Repo } from "../store/db.js";
import type { EnvKind, FeelingKind } from "./copy.js";
import { renderEnv, renderFeeling } from "./copy.js";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * 注入器:混合注入的落地点。
 * - 体感(kind+tier)→ 伪造 assistant 内心独白 <feeling>…</feeling>
 * - 环境事件 → 伪造 user 旁白 [环境] …
 * 注入先入队,由 loop 在下一次 kick 前统一 flush 进 agent.state.messages。
 */
export class Injector {
  private queue: AgentMessage[] = [];
  private lastFeeling = new Map<FeelingKind, { tier: number; simTs: number }>();
  private pendingEnv = new Map<EnvKind, number>();

  constructor(
    private readonly getModelApi: () => string,
    private readonly repo: Repo,
    private readonly simNow: () => number,
  ) {}

  queueFeeling(kind: FeelingKind, tier: number): boolean {
    const now = this.simNow();
    const last = this.lastFeeling.get(kind);
    // 同类同档不重复;升档立即注入。冷却由调用方(manager)控制,这里兜底去重。
    if (last && last.tier === tier) return false;
    this.lastFeeling.set(kind, { tier, simTs: now });
    const text = renderFeeling(kind, tier);
    this.queue.push(this.feelingMessage(text));
    this.repo.insertInjection(now, "feeling", kind, tier, text);
    return true;
  }

  queueEnv(kind: EnvKind, arg?: { n?: number; count?: number; note?: string }): void {
    const now = this.simNow();
    const text = renderEnv(kind, arg);
    this.queue.push(this.envMessage(text));
    this.pendingEnv.set(kind, (this.pendingEnv.get(kind) ?? 0) + 1);
    this.repo.insertInjection(now, "env", kind, null, text);
  }

  /** 同类环境感知是否已有待注入的(用于感知去重,防止消息风暴灌水) */
  hasPendingEnv(kind: EnvKind): boolean {
    return (this.pendingEnv.get(kind) ?? 0) > 0;
  }

  queueRawEnvText(text: string): void {
    const now = this.simNow();
    this.queue.push(this.envMessage(text));
    this.repo.insertInjection(now, "env", "raw", null, text);
  }

  /** 系统提示 section 热更新(如 memory 刷新),随队列一起 flush */
  queueSystemSections(sections: Record<string, string | null>): void {
    this.queue.push({ role: "system", content: "", sections, timestamp: Date.now() });
  }

  /** 取走全部待注入消息 */
  drain(): AgentMessage[] {
    const out = this.queue;
    this.queue = [];
    this.pendingEnv.clear();
    return out;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private envMessage(text: string): AgentMessage {
    return {
      role: "user",
      content: `[环境] ${text}`,
      timestamp: Date.now(),
    };
  }

  private feelingMessage(text: string): AgentMessage {
    return {
      role: "assistant",
      content: [{ type: "text", text: `<feeling>${text}</feeling>` }],
      api: this.getModelApi(),
      provider: "watching-bot",
      model: "inner-voice",
      usage: zeroUsage,
      stopReason: "stop",
      timestamp: Date.now(),
    } as AgentMessage;
  }
}

/** 追加一条系统 section 更新(如 memory/capabilities 刷新) */
export function systemSectionUpdate(sections: Record<string, string | null>): AgentMessage {
  return { role: "system", content: "", sections, timestamp: Date.now() };
}
