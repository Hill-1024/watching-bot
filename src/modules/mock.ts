import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { BotModule, ModuleCtx, PerceptionEvent } from "../bus/types.js";

/**
 * mock 模块:M1/M2 阶段的假能力提供方。
 * - 两个小工具(证明总线工具挂载链路;mock_reply 带 social 标签)
 * - 供测试/剧本侧调用的 emit 方法,主动上报感知事件(消息/被@风暴)
 * 定时剧本由测试侧用 clock.scheduleIn 驱动 —— 模块自身不持有定时器。
 */
export class MockModule implements BotModule {
  name = "mock";
  summary = "测试用假模块:mock_peek 看窗外、mock_reply 随口应一句,并按剧本上报感知";
  toolTags: Record<string, string[]> = { mock_reply: ["social"] };
  tools: AgentTool<any>[] = [];
  private ctx: ModuleCtx | null = null;

  async init(ctx: ModuleCtx): Promise<void> {
    this.ctx = ctx;
    this.tools = [
      {
        name: "mock_peek",
        label: "看看窗外",
        description: "往窗外看一眼。测试工具。",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "窗外天色平常,没什么特别。" }],
          details: {},
        }),
      },
      {
        name: "mock_reply",
        label: "随口应一句",
        description: "对着空气随口说一句话(测试社交类工具)。",
        parameters: Type.Object({ text: Type.String({ description: "说的话" }) }),
        execute: async (_id, params: any) => ({
          content: [{ type: "text", text: `你小声嘀咕了一句:「${params.text}」` }],
          details: {},
        }),
      },
    ];
  }

  /** 剧本入口:上报一条消息感知 */
  emitMessage(intensity = 1): void {
    this.ctx?.emitPerception({ kind: "message", intensity, source: "mock" } satisfies PerceptionEvent);
  }

  /** 剧本入口:上报一轮被@风暴(一次 N 条) */
  emitMentionStorm(count = 8, intensity = 2): void {
    for (let i = 0; i < count; i++) {
      this.ctx?.emitPerception({ kind: "mention", intensity, source: "mock" } satisfies PerceptionEvent);
    }
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }
}

export function mockModuleFactory(hook?: (m: MockModule) => void): () => BotModule {
  return () => {
    const m = new MockModule();
    hook?.(m);
    return m;
  };
}
