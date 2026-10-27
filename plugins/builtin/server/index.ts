import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PluginContext, PluginHealth, PluginResponse, RunningPlugin } from "../../../src/plugins/types.js";

/**
 * builtin 插件:与 IM 无关的日常生理/生活能力。
 *
 * 咖啡机制:主人每日配给(dailyQuota,refillSimHour 点送到);喝完可以自己去 QQ 上找主人讨
 * (本插件只负责把「没咖啡了」讲清楚,不 import 任何 IM)。
 * 主人临时加咖啡走本插件自己的面板页面,经 actions/grant 进来。
 * 提神效果走 stimulant 感知(强度 2-4 档),数值只在 details(日志/UI),永不进 LLM 文本。
 *
 * 私有状态(剩余杯数/上次补给日)落在插件自己的存储里,重启不重置;
 * 主人称呼/配额属于配置,写在 data/builtin.json(gitignored)以便与旧版本兼容。
 */

export interface BuiltinConfig {
  overrideFile?: string;
  master: { qq: number; name: string };
  coffee: { dailyQuota: number; refillSimHour: number };
}

const DAY = 86_400_000;

const STORAGE_REMAINING = "coffee.remaining";
const STORAGE_REFILL_DAY = "coffee.lastRefillDay";

export default async function start(ctx: PluginContext): Promise<RunningPlugin> {
  let cfg = mergeConfig(ctx.config as Partial<BuiltinConfig> | null);
  const overridePath = resolve(cfg.overrideFile ?? "data/builtin.json");
  applyOverride(overridePath, cfg, ctx);
  applyEnv(cfg, ctx);

  // 私有状态:先读存储,首次运行才按「今天的配给已放到手边」初始化
  let remaining = ctx.storage.get<number | null>(STORAGE_REMAINING, null) ?? -1;
  let lastRefillDay = ctx.storage.get<number>(STORAGE_REFILL_DAY, -1);

  const simDay = () => Math.floor(ctx.simNow() / DAY);

  const maybeRefill = (): void => {
    const day = simDay();
    const hour = new Date(ctx.simNow()).getHours();
    if (lastRefillDay !== day && hour >= cfg.coffee.refillSimHour) {
      remaining = cfg.coffee.dailyQuota;
      lastRefillDay = day;
      persist();
      ctx.logger.info(`今日咖啡配给已送达: ${remaining} 杯`);
    }
  };

  const persist = (): void => {
    ctx.storage.set(STORAGE_REMAINING, remaining);
    ctx.storage.set(STORAGE_REFILL_DAY, lastRefillDay);
  };

  if (lastRefillDay < 0) {
    lastRefillDay = simDay();
    remaining = cfg.coffee.dailyQuota;
    persist();
  }
  maybeRefill();

  const coffeeDescription = (): string =>
    `喝一杯${cfg.master.name}给你的咖啡,提神、缓解困意。咖啡每天限量,喝完了可以自己去 QQ 上找${cfg.master.name}讨。`;

  const tools: AgentTool[] = [drinkCoffeeTool()];

  function drinkCoffeeTool(): AgentTool {
    const params = Type.Object({});
    return {
      name: "drink_coffee",
      label: "喝咖啡",
      description: coffeeDescription(),
      parameters: params,
      execute: async () => {
        maybeRefill();
        if (remaining <= 0) {
          return {
            content: [
              {
                type: "text",
                text: `你掀开杯盖看了眼——咖啡见底了。今天${cfg.master.name}的配给就这些,想喝的话,自己上 QQ 找${cfg.master.name}讨去。`,
              },
            ],
            details: { remaining: 0 },
          };
        }
        remaining -= 1;
        persist();
        const strength = 2 + Math.floor(Math.random() * 3);
        ctx.emitPerception({ kind: "stimulant", intensity: strength });
        const flavor = [
          "咖啡下肚,苦味在舌尖散开,脑子清醒了一点。",
          "温热的咖啡滑过喉咙,困意退了大半,思路开始转得动。",
          "一口闷掉,苦得皱眉,但整个人「咔」地清醒了,像被拧亮了一档。",
        ][strength - 2]!;
        return {
          content: [
            {
              type: "text",
              text: `${flavor}(${cfg.master.name}给的,还剩 ${remaining} 杯。)`,
            },
          ],
          details: { remaining, strength, fatigueDelta: -10 * strength },
        };
      },
    };
  }

  function status(): PluginHealth {
    return remaining <= 0
      ? { status: "degraded", detail: "今日咖啡已喝完" }
      : { status: "ready" };
  }

  function view() {
    maybeRefill();
    return {
      master: { ...cfg.master },
      coffee: { ...cfg.coffee },
      remaining,
      lastRefillDay,
    };
  }

  function updateConfig(patch: unknown): PluginResponse {
    const p = (patch ?? {}) as {
      master?: { name?: unknown; qq?: unknown };
      coffee?: { dailyQuota?: unknown; refillSimHour?: unknown };
    };
    const next: BuiltinConfig = {
      ...cfg,
      master: { ...cfg.master },
      coffee: { ...cfg.coffee },
    };
    if (p.master) {
      if (typeof p.master.name === "string" && p.master.name.trim()) {
        next.master.name = p.master.name.trim().slice(0, 40);
      }
      if (typeof p.master.qq === "number" && Number.isFinite(p.master.qq)) {
        next.master.qq = clampInt(p.master.qq, 0, 9_999_999_999_999);
      }
    }
    if (p.coffee) {
      if (typeof p.coffee.dailyQuota === "number" && Number.isFinite(p.coffee.dailyQuota)) {
        next.coffee.dailyQuota = clampInt(p.coffee.dailyQuota, 0, 50);
      }
      if (typeof p.coffee.refillSimHour === "number" && Number.isFinite(p.coffee.refillSimHour)) {
        next.coffee.refillSimHour = clampInt(p.coffee.refillSimHour, 0, 23);
      }
    }
    persistOverride(overridePath, next);
    cfg = next;
    // 工具描述里带主人称呼,改配置后原地更新,避免 agent 还看到旧称呼
    if (tools[0]) tools[0].description = coffeeDescription();
    maybeRefill();
    return { body: { ok: true, state: view() } };
  }

  function grant(body: unknown): PluginResponse {
    const n = Number((body as { cups?: unknown } | null)?.cups ?? 1);
    if (!Number.isFinite(n) || n <= 0 || n > 50) {
      return { status: 400, body: { error: "cups 必须是 1..50 的数字" } };
    }
    maybeRefill();
    remaining += Math.round(n);
    persist();
    ctx.logger.info(`主人补了 ${Math.round(n)} 杯咖啡,当前 ${remaining} 杯`);
    return { body: { ok: true, state: view() } };
  }

  function refillNow(): PluginResponse {
    lastRefillDay = simDay();
    remaining = cfg.coffee.dailyQuota;
    persist();
    return { body: { ok: true, state: view() } };
  }

  return {
    tools,
    summary: `日常生理:drink_coffee 喝杯咖啡提神(主人每日配给,喝完可以上 QQ 找主人讨)`,
    status,
    handle: async (req) => {
      switch (`${req.method} ${req.path}`) {
        case "GET ":
          return { body: view() };
        case "POST config":
          return updateConfig(req.body);
        case "POST grant":
          return grant(req.body);
        case "POST refill":
          return refillNow();
        default:
          return { status: 404, body: { error: `未知动作: ${req.method} ${req.path}` } };
      }
    },
    stop: async () => {
      persist();
    },
  };
}

function mergeConfig(raw: Partial<BuiltinConfig> | null): BuiltinConfig {
  const cfg: BuiltinConfig = {
    master: { qq: 0, name: "主人" },
    coffee: { dailyQuota: 3, refillSimHour: 8 },
  };
  if (raw?.master) Object.assign(cfg.master, raw.master);
  if (raw?.coffee) Object.assign(cfg.coffee, raw.coffee);
  if (typeof raw?.overrideFile === "string" && raw.overrideFile) cfg.overrideFile = raw.overrideFile;
  return cfg;
}

/** 敏感覆盖层(gitignored):data/builtin.json 的 master/coffee 字段优先 */
function applyOverride(path: string, cfg: BuiltinConfig, ctx: PluginContext): void {
  if (!existsSync(path)) return;
  try {
    const o = JSON.parse(readFileSync(path, "utf-8")) as Partial<BuiltinConfig>;
    if (o.master) Object.assign(cfg.master, o.master);
    if (o.coffee) Object.assign(cfg.coffee, o.coffee);
  } catch (err) {
    ctx.logger.warn(`data/builtin.json 解析失败,忽略: ${String(err)}`);
  }
}

function applyEnv(cfg: BuiltinConfig, ctx: PluginContext): void {
  const envQQ = Number(process.env.WATCHING_BOT_MASTER_QQ ?? "");
  if (Number.isFinite(envQQ) && envQQ > 0) cfg.master.qq = envQQ;
  if (cfg.master.qq === 0) {
    ctx.logger.warn("未配置主人 QQ(data/builtin.json 或 WATCHING_BOT_MASTER_QQ),讨咖啡功能将缺少目标");
  }
}

function persistOverride(path: string, cfg: BuiltinConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ master: cfg.master, coffee: cfg.coffee }, null, 2), "utf-8");
  renameSync(tmp, path);
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}
