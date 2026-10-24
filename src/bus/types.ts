import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * 模块总线契约 —— 本项目最重要的接口。
 *
 * agent 与一切外部能力之间只隔这一层:对 agent 而言,所有模块
 * (napcat、未来的其他 IM 适配器/沙箱电脑/联网搜索)只是一堆
 * 可调用的黑箱工具。模块任意迭代、插拔、新增,agent 代码零改动。
 *
 * 依赖方向铁律:modules → bus ← core ← state-manager
 * 模块永不接触提示词、状态、注入 —— 它只提供工具和感知。
 */

/** 感知事件种类:接口层定义的开放小枚举。新模块优先复用现有 kind。 */
export type PerceptionKind = "message" | "mention" | "mention_storm" | "alert";

export interface PerceptionEvent {
  kind: PerceptionKind;
  /** 1-5,5 最强。同 kind 事件由核心做窗口聚合升级。 */
  intensity: number;
  /** 可选来源标识(如聊天 id),仅用于日志/去重,核心不得据此生成提示词内容。 */
  source?: string;
}

export interface ModuleCtx {
  /** config/modules.<name> 段,模块自带解析 */
  config: unknown;
  /** 上报感知 —— 模块对核心的唯一反向通道 */
  emitPerception(e: PerceptionEvent): void;
  /** 当前模拟时间戳(ms),模块需要排程时用这个,不要用 Date.now() */
  simNow(): number;
  log: (msg: string) => void;
}

export interface BotModule {
  name: string;
  /** 一句话能力简介,进入系统提示「可用能力」段 */
  summary: string;
  /** 黑箱工具集,自描述(name/description/TypeBox 参数) */
  tools: AgentTool[];
  /**
   * 工具语义标签:工具名 → 语义(如 "social")。
   * 状态管理器只认语义标签,永远不认识具体模块 —— 这是它对模块零感知的关键。
   */
  toolTags?: Record<string, string[]>;
  init(ctx: ModuleCtx): Promise<void>;
  stop(): Promise<void>;
}

export interface ModuleStatus {
  name: string;
  summary: string;
  toolNames: string[];
  started: boolean;
}

/** 总线对核心暴露的视图 */
export interface ModuleBus {
  /** 装配并启动配置列出的模块 */
  startAll(moduleNames: string[]): Promise<void>;
  stopAll(): Promise<void>;
  /** 全部已启动模块的黑箱工具拼合(直接挂到 pi Agent) */
  allTools(): AgentTool[];
  /** 工具的语义标签(状态管理器消费,如 "social") */
  toolTags(toolName: string): string[];
  /** 系统提示「可用能力」段,由模块 summary 动态生成 */
  capabilitySection(): string;
  status(): ModuleStatus[];
  /** 核心订阅感知事件(核心负责翻译成体感注入) */
  onPerception(cb: (e: PerceptionEvent) => void): void;
}
