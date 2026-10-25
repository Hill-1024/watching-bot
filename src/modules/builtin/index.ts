import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { BotModule, ModuleCtx, PerceptionEvent } from "../../bus/types.js";

export interface BuiltinModuleConfig {
  /** 敏感覆盖层路径,默认 data/builtin.json(gitignored) */
  overrideFile?: string;
  master: {
    /** 主人 QQ 号:喝完咖啡后 bot 会自己去 QQ 上找这位讨。敏感值放 data/builtin.json 覆盖层,勿入 git */
    qq: number;
    /** 称呼:bot 怎么喊主人(工具描述与文案里出现) */
    name: string;
  };
  coffee: {
    /** 一天配给多少杯(主人设定) */
    dailyQuota: number;
    /** 每天几点「送到」(模拟时间小时) */
    refillSimHour: number;
  };
}

const DAY = 86_400_000;

/**
 * builtin 模块:与 IM 无关的日常生理/生活能力。
 * 咖啡机制:主人每日配给(dailyQuota,refillSimHour 点送到);喝完可以上 QQ 找主人讨
 * (讨的动作就是 bot 自己调 napcat 的 send_message,本模块只负责把「没咖啡了」讲清楚);
 * 主人临时加咖啡走管理面板(POST /api/coffee,经 grantCoffee 进来)。
 * 提神效果走 stimulant 感知(强度1-5档),数值只在 details(日志/UI),永不进 LLM 文本。
 */
export class BuiltinModule implements BotModule {
  name = "builtin";
  summary = "日常生理:drink_coffee 喝杯咖啡提神(主人每日配给,喝完可以上 QQ 找主人讨)";
  tools: AgentTool<any>[] = [];

  private ctx: ModuleCtx | null = null;
  private cfg: BuiltinModuleConfig = {
    master: { qq: 0, name: "主人" },
    coffee: { dailyQuota: 3, refillSimHour: 8 },
  };
  private remaining = 0;
  private lastRefillDay = -1;
  private overridePath = "data/builtin.json";

  async init(ctx: ModuleCtx): Promise<void> {
    this.ctx = ctx;
    const c = (ctx.config ?? {}) as Partial<BuiltinModuleConfig>;
    if (c.master) Object.assign(this.cfg.master, c.master);
    if (c.coffee) Object.assign(this.cfg.coffee, c.coffee);
    // 敏感覆盖层(gitignored):data/builtin.json 的 master/coffee 字段优先
    this.overridePath = typeof c.overrideFile === "string" && c.overrideFile
      ? c.overrideFile
      : "data/builtin.json";
    const overridePath = resolve(this.overridePath);
    if (existsSync(overridePath)) {
      try {
        const o = JSON.parse(readFileSync(overridePath, "utf-8")) as Partial<BuiltinModuleConfig>;
        if (o.master) Object.assign(this.cfg.master, o.master);
        if (o.coffee) Object.assign(this.cfg.coffee, o.coffee);
      } catch (err) {
        ctx.log(`data/builtin.json 解析失败,忽略: ${String(err)}`);
      }
    }
    // 环境变量兜底(优先级最高)
    const envQQ = Number(process.env.WATCHING_BOT_MASTER_QQ ?? "");
    if (Number.isFinite(envQQ) && envQQ > 0) this.cfg.master.qq = envQQ;
    if (this.cfg.master.qq === 0) {
      ctx.log("[warn] 未配置主人 QQ(data/builtin.json 或 WATCHING_BOT_MASTER_QQ),讨咖啡功能将缺少目标");
    }
    this.maybeRefill();
    // 开局按「今天的配给已放到手边」处理,别让 bot 第一天就讨咖啡
    if (this.lastRefillDay < 0) {
      this.lastRefillDay = this.simDay();
      this.remaining = this.cfg.coffee.dailyQuota;
    }
    this.buildTools();
  }

  private simNow(): number {
    return this.ctx?.simNow() ?? Date.now();
  }

  private simDay(): number {
    return Math.floor(this.simNow() / DAY);
  }

  /** 配给送达检查(懒触发:面板/喝咖啡时都会过一遍) */
  private maybeRefill(): void {
    const day = this.simDay();
    const hour = new Date(this.simNow()).getHours();
    if (this.lastRefillDay !== day && hour >= this.cfg.coffee.refillSimHour) {
      this.remaining = this.cfg.coffee.dailyQuota;
      this.lastRefillDay = day;
      this.ctx?.log(`今日咖啡配给已送达: ${this.remaining} 杯`);
    }
  }

  /** 主人临时加咖啡(面板) */
  grantCoffee(n: number): void {
    this.maybeRefill();
    this.remaining += Math.max(0, Math.round(n));
  }

  coffeeRemaining(): number {
    this.maybeRefill();
    return this.remaining;
  }

  /** 面板读取当前生效配置(含 data/builtin.json 与环境变量覆盖) */
  configView(): { master: { name: string; qq: number }; coffee: { dailyQuota: number; refillSimHour: number } } {
    return {
      master: { ...this.cfg.master },
      coffee: { ...this.cfg.coffee },
    };
  }

  /**
   * 面板修改配置:先原子写入 data/builtin.json,成功后再热应用并重建工具。
   * 写入失败时内存配置保持不变,避免面板显示与实际落盘不一致。
   */
  updateConfig(patch: {
    master?: { name?: string; qq?: number };
    coffee?: { dailyQuota?: number };
  }): void {
    const next: BuiltinModuleConfig = {
      ...this.cfg,
      master: { ...this.cfg.master },
      coffee: { ...this.cfg.coffee },
    };
    if (patch.master) {
      if (typeof patch.master.name === "string" && patch.master.name.trim()) {
        next.master.name = patch.master.name.trim().slice(0, 40);
      }
      if (typeof patch.master.qq === "number" && Number.isFinite(patch.master.qq)) {
        next.master.qq = Math.max(0, Math.min(9_999_999_999_999, Math.round(patch.master.qq)));
      }
    }
    if (patch.coffee && typeof patch.coffee.dailyQuota === "number" && Number.isFinite(patch.coffee.dailyQuota)) {
      next.coffee.dailyQuota = Math.max(0, Math.min(50, Math.round(patch.coffee.dailyQuota)));
    }
    this.persistConfig(next);
    this.cfg = next;
    this.buildTools();
  }

  private persistConfig(cfg: BuiltinModuleConfig): void {
    const path = resolve(this.overridePath);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ master: cfg.master, coffee: cfg.coffee }, null, 2), "utf-8");
    renameSync(tmp, path);
  }

  private buildTools(): void {
    const name = this.cfg.master.name;
    const drinkParams = Type.Object({});
    const drinkCoffee: AgentTool<typeof drinkParams> = {
      name: "drink_coffee",
      label: "喝咖啡",
      description: `喝一杯${name}给你的咖啡,提神、缓解困意。咖啡每天限量,喝完了可以自己去 QQ 上找${name}讨。`,
      parameters: drinkParams,
      execute: async () => {
        this.maybeRefill();
        if (this.remaining <= 0) {
          return {
            content: [{
              type: "text",
              text: `你掀开杯盖看了眼——咖啡见底了。今天${name}的配给就这些,想喝的话,自己上 QQ 找${name}讨去。`,
            }],
            details: { remaining: 0 },
          };
        }
        this.remaining -= 1;
        // 提神强度 2-4 档(疲惫 -20 ~ -40),数值只进 details,LLM 只看到体感文案
        const strength = 2 + Math.floor(Math.random() * 3);
        this.ctx?.emitPerception({ kind: "stimulant", intensity: strength } satisfies PerceptionEvent);
        const flavor = [
          "咖啡下肚,苦味在舌尖散开,脑子清醒了一点。",
          "温热的咖啡滑过喉咙,困意退了大半,思路开始转得动。",
          "一口闷掉,苦得皱眉,但整个人「咔」地清醒了,像被拧亮了一档。",
        ][strength - 2]!;
        return {
          content: [{
            type: "text",
            text: `${flavor}(${name}给的,还剩 ${this.remaining} 杯。)`,
          }],
          details: { remaining: this.remaining, strength, fatigueDelta: -10 * strength },
        };
      },
    };
    this.tools = [drinkCoffee];
  }

  async stop(): Promise<void> {
    this.ctx = null;
  }
}

export function builtinModuleFactory(): BotModule {
  return new BuiltinModule();
}
