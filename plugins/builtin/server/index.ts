import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PluginContext, PluginHealth, PluginResponse, RunningPlugin } from "../../../src/plugins/types.js";
import {
  buildWebSearchTool,
  deepseekApiKey,
  formatSearchResults,
  mergeWebSearch,
  runWebSearch,
  searchProviderInfo,
  type WebSearchConfig,
} from "./search.js";
import {
  buildHostTools,
  hostToolsView,
  mergeHostTools,
  patchHostTools,
  type HostToolsConfig,
} from "./host.js";

/**
 * builtin 插件:与 IM 无关的日常生理/生活/上网能力。
 *
 * - 咖啡机制:主人每日配给(dailyQuota,refillSimHour 点送到);喝完可以自己去 QQ 上找主人讨
 *   (本插件只负责把「没咖啡了」讲清楚,不 import 任何 IM)。
 * - 联网搜索:web_search 一个工具,后端可选 DeepSeek 官方搜索端点或 SearXNG。
 *
 * 私有状态(剩余杯数/上次补给日)落在插件自己的存储里,重启不重置;
 * 主人称呼/配额、搜索配置写在 data/builtin.json(gitignored)以便与旧版本兼容。
 */

export interface BuiltinConfig {
  overrideFile?: string;
  master: { qq: number; name: string };
  coffee: { dailyQuota: number; refillSimHour: number };
  webSearch: WebSearchConfig;
  hostTools: HostToolsConfig;
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

  const searchTool = buildWebSearchTool(() => cfg.webSearch, ctx.logger);
  const hostTools = cfg.hostTools.enabled ? buildHostTools(() => cfg.hostTools, ctx.logger) : [];
  // 顺序有意义:既有测试和提示词假设第 0 个是喝咖啡,新工具都往后追加
  const tools: AgentTool[] = [drinkCoffeeTool(), searchTool, ...hostTools];

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
    const searchInfo = searchProviderInfo(cfg.webSearch);
    const apiKeySet = Boolean(deepseekApiKey(cfg.webSearch));
    return {
      master: { ...cfg.master },
      coffee: { ...cfg.coffee },
      remaining,
      lastRefillDay,
      webSearch: {
        provider: cfg.webSearch.provider,
        searxng: { ...cfg.webSearch.searxng },
        deepseek: { ...cfg.webSearch.deepseek, apiKey: "", apiKeySet },
      },
      hostTools: hostToolsView(cfg.hostTools),
      search: {
        provider: searchInfo.provider,
        configured: searchInfo.provider != null,
        detail: searchInfo.detail,
      },
    };
  }

  function updateConfig(patch: unknown): PluginResponse {
    try {
      const next = patchConfig(cfg, patch);
      persistOverride(overridePath, next);
      cfg = next;
      // 工具描述里带主人称呼,改配置后原地更新,避免 agent 还看到旧称呼
      if (tools[0]) tools[0].description = coffeeDescription();
      maybeRefill();
      return { body: { ok: true, state: view() } };
    } catch (err) {
      return { status: 400, body: { error: err instanceof Error ? err.message : String(err) } };
    }
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

  async function testSearch(body: unknown): Promise<PluginResponse> {
    const query = String((body as { query?: unknown } | null)?.query ?? "").trim() || "今天有什么新闻";
    try {
      const outcome = await runWebSearch(cfg.webSearch, { query, count: 3 }, ctx.logger);
      return { body: { ok: true, provider: outcome.provider, text: formatSearchResults(query, outcome) } };
    } catch (err) {
      return { status: 502, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  return {
    tools,
    summary:
      "日常与上网:drink_coffee 喝杯咖啡提神(主人每日配给,喝完可以上 QQ 找主人讨);" +
      "web_search 联网搜索(DeepSeek / SearXNG)" +
      (cfg.hostTools.enabled
        ? `;宿主能力:read_file 读文件、write_file 写文件、list_files 列目录${
            cfg.hostTools.shellEnabled ? "、run_shell 执行命令" : ""
          }(工作目录 ${cfg.hostTools.workdir})`
        : ""),
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
        case "POST search/test":
          return testSearch(req.body);
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
    webSearch: mergeWebSearch((raw as Record<string, unknown> | null)?.webSearch),
    hostTools: mergeHostTools((raw as Record<string, unknown> | null)?.hostTools),
  };
  if (raw?.master) Object.assign(cfg.master, raw.master);
  if (raw?.coffee) Object.assign(cfg.coffee, raw.coffee);
  if (typeof raw?.overrideFile === "string" && raw.overrideFile) cfg.overrideFile = raw.overrideFile;
  return cfg;
}

/** 敏感覆盖层(gitignored):data/builtin.json 的字段优先;未写的字段沿用默认 */
function applyOverride(path: string, cfg: BuiltinConfig, ctx: PluginContext): void {
  if (!existsSync(path)) return;
  try {
    const raw = asObject(JSON.parse(readFileSync(path, "utf-8")));
    if (raw.master) Object.assign(cfg.master, asObject(raw.master));
    if (raw.coffee) Object.assign(cfg.coffee, asObject(raw.coffee));
    if (raw.webSearch) {
      const ws = asObject(raw.webSearch);
      cfg.webSearch = mergeWebSearch({
        ...cfg.webSearch,
        ...ws,
        searxng: { ...cfg.webSearch.searxng, ...asObject(ws.searxng) },
        deepseek: { ...cfg.webSearch.deepseek, ...asObject(ws.deepseek) },
      });
    }
    if (raw.hostTools) cfg.hostTools = mergeHostTools({ ...cfg.hostTools, ...asObject(raw.hostTools) });
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
  if (!cfg.webSearch.searxng.baseUrl.trim()) {
    cfg.webSearch.searxng.baseUrl = (process.env.WATCHING_BOT_SEARXNG_URL ?? "").trim();
  }
}

function persistOverride(path: string, cfg: BuiltinConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  // 保留未知字段(例如旧版本留下的 webSearch.deepseek.model),只覆盖本插件认识的键
  let existing: Record<string, unknown> = {};
  try {
    existing = asObject(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    existing = {};
  }
  const existingWs = asObject(existing.webSearch);
  const out = {
    ...existing,
    master: cfg.master,
    coffee: cfg.coffee,
    webSearch: {
      ...existingWs,
      provider: cfg.webSearch.provider,
      searxng: { ...asObject(existingWs.searxng), ...cfg.webSearch.searxng },
      deepseek: { ...asObject(existingWs.deepseek), ...cfg.webSearch.deepseek },
    },
    hostTools: cfg.hostTools,
  };
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(out, null, 2), "utf-8");
  renameSync(tmp, path);
}

type ConfigPatch = {
  master?: { name?: unknown; qq?: unknown };
  coffee?: { dailyQuota?: unknown; refillSimHour?: unknown };
  hostTools?: Record<string, unknown>;
  webSearch?: {
    provider?: unknown;
    searxng?: {
      baseUrl?: unknown;
      maxResults?: unknown;
      language?: unknown;
      categories?: unknown;
      timeoutMs?: unknown;
    };
    deepseek?: {
      baseUrl?: unknown;
      apiKey?: unknown;
      apiKeyEnv?: unknown;
      count?: unknown;
      needContent?: unknown;
      timeoutMs?: unknown;
      clearApiKey?: unknown;
    };
  };
};

function patchConfig(cfg: BuiltinConfig, patch: unknown): BuiltinConfig {
  const p = asObject(patch) as ConfigPatch;
  const next: BuiltinConfig = {
    ...cfg,
    master: { ...cfg.master },
    coffee: { ...cfg.coffee },
    webSearch: {
      ...cfg.webSearch,
      searxng: { ...cfg.webSearch.searxng },
      deepseek: { ...cfg.webSearch.deepseek },
    },
    hostTools: { ...cfg.hostTools },
  };

  if (p.hostTools) next.hostTools = patchHostTools(cfg.hostTools, p.hostTools);

  if (p.master) {
    const m = asObject(p.master);
    if (typeof m.name === "string" && m.name.trim()) next.master.name = m.name.trim().slice(0, 40);
    if (typeof m.qq === "number" && Number.isFinite(m.qq)) next.master.qq = clampInt(m.qq, 0, 9_999_999_999_999);
  }

  if (p.coffee) {
    const c = asObject(p.coffee);
    if (typeof c.dailyQuota === "number" && Number.isFinite(c.dailyQuota)) {
      next.coffee.dailyQuota = clampInt(c.dailyQuota, 0, 50);
    }
    if (typeof c.refillSimHour === "number" && Number.isFinite(c.refillSimHour)) {
      next.coffee.refillSimHour = clampInt(c.refillSimHour, 0, 23);
    }
  }

  if (p.webSearch) {
    const ws = asObject(p.webSearch);
    if (ws.provider !== undefined) {
      if (ws.provider !== "auto" && ws.provider !== "deepseek" && ws.provider !== "searxng") {
        throw new Error('webSearch.provider 只能是 "auto" / "deepseek" / "searxng"');
      }
      next.webSearch.provider = ws.provider;
    }
    if (ws.searxng) {
      const s = asObject(ws.searxng);
      if (s.baseUrl !== undefined) {
        next.webSearch.searxng.baseUrl = httpUrl(s.baseUrl, "webSearch.searxng.baseUrl");
      }
      if (typeof s.maxResults === "number" && Number.isFinite(s.maxResults)) {
        next.webSearch.searxng.maxResults = clampInt(s.maxResults, 1, 20);
      }
      if (typeof s.language === "string") next.webSearch.searxng.language = s.language.trim().slice(0, 40);
      if (typeof s.categories === "string") next.webSearch.searxng.categories = s.categories.trim().slice(0, 80);
      if (typeof s.timeoutMs === "number" && Number.isFinite(s.timeoutMs)) {
        next.webSearch.searxng.timeoutMs = clampInt(s.timeoutMs, 1000, 60_000);
      }
    }
    if (ws.deepseek) {
      const d = asObject(ws.deepseek);
      if (d.baseUrl !== undefined) {
        next.webSearch.deepseek.baseUrl = httpUrl(d.baseUrl, "webSearch.deepseek.baseUrl");
      }
      if (d.clearApiKey === true) next.webSearch.deepseek.apiKey = "";
      else if (typeof d.apiKey === "string" && d.apiKey.trim()) {
        next.webSearch.deepseek.apiKey = d.apiKey.trim();
      }
      if (typeof d.apiKeyEnv === "string" && d.apiKeyEnv.trim()) {
        next.webSearch.deepseek.apiKeyEnv = d.apiKeyEnv.trim().slice(0, 80);
      }
      if (typeof d.count === "number" && Number.isFinite(d.count)) {
        next.webSearch.deepseek.count = clampInt(d.count, 1, 20);
      }
      if (typeof d.needContent === "boolean") next.webSearch.deepseek.needContent = d.needContent;
      if (typeof d.timeoutMs === "number" && Number.isFinite(d.timeoutMs)) {
        next.webSearch.deepseek.timeoutMs = clampInt(d.timeoutMs, 1000, 60_000);
      }
    }
  }

  return next;
}

function httpUrl(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} 必须是字符串`);
  const trimmed = value.trim();
  if (!trimmed) return "";
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${field} 不是合法网址: ${trimmed}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} 只支持 http:// 或 https://`);
  }
  return trimmed.replace(/\/+$/, "");
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function clampInt(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(v)));
}
