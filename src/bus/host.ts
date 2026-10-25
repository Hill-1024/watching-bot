import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  BotModule,
  ModuleBus,
  ModuleCtx,
  ModuleStatus,
  PerceptionEvent,
} from "./types.js";

export interface ClockRef {
  /** 当前模拟时间戳 ms */
  simNow(): number;
}

export type ModuleFactory = (moduleConfig: unknown) => BotModule;

/**
 * 模块总线实现:按配置装配模块,聚合工具,转发感知事件。
 * 核心与状态管理不 import 任何具体模块;模块之间互不相识。
 */
export class ModuleHost implements ModuleBus {
  private readonly modules = new Map<string, BotModule>();
  private readonly factories = new Map<string, ModuleFactory>();
  private readonly moduleConfigs = new Map<string, unknown>();
  private perceptionCbs: ((e: PerceptionEvent) => void)[] = [];
  private readonly log: (msg: string) => void;
  private readonly clock: ClockRef;

  constructor(opts: {
    clock: ClockRef;
    log?: (msg: string) => void;
    moduleConfigs?: Record<string, unknown>;
  }) {
    this.clock = opts.clock;
    this.log = opts.log ?? (() => {});
    this.moduleConfigs = new Map(Object.entries(opts.moduleConfigs ?? {}));
  }

  /** 工厂注册表 —— 新模块在这里挂工厂即可被 config.modules 启用 */
  registerFactory(name: string, factory: ModuleFactory): void {
    this.factories.set(name, factory);
  }

  /** 已注册工厂名(面板展示"可启用"模块用) */
  factoryNames(): string[] {
    return [...this.factories.keys()];
  }

  async startAll(moduleNames: string[]): Promise<void> {
    for (const name of moduleNames) {
      const factory = this.factories.get(name);
      if (!factory) {
        this.log(`[bus] 未注册的模块工厂: ${name},跳过`);
        continue;
      }
      if (this.modules.has(name)) continue;
      const mod = factory(this.moduleConfigs.get(name) ?? {});
      const ctx: ModuleCtx = {
        config: this.moduleConfigs.get(name) ?? {},
        emitPerception: (e) => {
          for (const cb of this.perceptionCbs) cb(e);
        },
        simNow: () => this.clock.simNow(),
        log: (msg) => this.log(`[${name}] ${msg}`),
      };
      await mod.init(ctx);
      this.modules.set(name, mod);
      this.log(`[bus] 模块已启动: ${name} (工具: ${mod.tools.map((t) => t.name).join(", ")})`);
    }
  }

  async stopAll(): Promise<void> {
    for (const [name, mod] of this.modules) {
      try {
        await mod.stop();
      } catch (err) {
        this.log(`[bus] 模块 ${name} stop 失败: ${String(err)}`);
      }
    }
    this.modules.clear();
  }

  /** 热插拔:启动单个模块(面板用) */
  async startOne(name: string): Promise<boolean> {
    if (this.modules.has(name)) return true;
    const factory = this.factories.get(name);
    if (!factory) return false;
    const mod = factory(this.moduleConfigs.get(name) ?? {});
    const ctx: ModuleCtx = {
      config: this.moduleConfigs.get(name) ?? {},
      emitPerception: (e) => {
        for (const cb of this.perceptionCbs) cb(e);
      },
      simNow: () => this.clock.simNow(),
      log: (msg) => this.log(`[${name}] ${msg}`),
    };
    await mod.init(ctx);
    this.modules.set(name, mod);
    this.log(`[bus] 模块已启动: ${name}`);
    return true;
  }

  /** 热插拔:停止单个模块(面板用) */
  async stopOne(name: string): Promise<boolean> {
    const mod = this.modules.get(name);
    if (!mod) return false;
    this.modules.delete(name);
    try {
      await mod.stop();
    } catch (err) {
      this.log(`[bus] 模块 ${name} stop 失败: ${String(err)}`);
    }
    this.log(`[bus] 模块已停止: ${name}`);
    return true;
  }

  allTools(): AgentTool[] {
    return [...this.modules.values()].flatMap((m) => m.tools);
  }

  /** 工具的语义标签(状态管理器消费,如 "social") */
  toolTags(toolName: string): string[] {
    for (const m of this.modules.values()) {
      const tags = m.toolTags?.[toolName];
      if (tags) return tags;
    }
    return [];
  }

  /** 按名取运行中的模块实例(面板操作特化能力用,如 builtin 的咖啡配给) */
  get(name: string): BotModule | undefined {
    return this.modules.get(name);
  }

  capabilitySection(): string {
    const mods = [...this.modules.values()];
    if (mods.length === 0) return "(当前没有接入任何外部能力模块)";
    return mods.map((m) => `- ${m.summary}`).join("\n");
  }

  status(): ModuleStatus[] {
    return [...this.modules.values()].map((m) => ({
      name: m.name,
      summary: m.summary,
      toolNames: m.tools.map((t) => t.name),
      started: true,
    }));
  }

  onPerception(cb: (e: PerceptionEvent) => void): void {
    this.perceptionCbs.push(cb);
  }
}
