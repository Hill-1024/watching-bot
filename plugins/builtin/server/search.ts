import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PluginLogger } from "../../../src/plugins/types.js";

/**
 * 联网搜索:一个工具,两种后端。
 *
 * - DeepSeek 官方搜索端点 POST /v1/tools/search(见 api-docs.deepseek.com/zh-cn/guides/search)
 * - SearXNG 实例 GET /search?format=json
 *
 * provider = auto 时优先 DeepSeek(key 已配置),否则用 SearXNG。
 * 搜索只在工具调用时发生;没配置就把「怎么配」讲清楚,不抛裸异常。
 */

export interface WebSearchConfig {
  provider: "auto" | "deepseek" | "searxng";
  searxng: {
    baseUrl: string;
    maxResults: number;
    language: string;
    categories: string;
    timeoutMs: number;
  };
  deepseek: {
    baseUrl: string;
    apiKey: string;
    apiKeyEnv: string;
    count: number;
    needContent: boolean;
    timeoutMs: number;
  };
}

export interface SearchParams {
  query: string;
  count?: number;
  needContent?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  summary?: string;
  content?: string;
  siteName?: string;
  date?: string;
  score?: number;
}

export interface SearchOutcome {
  provider: "deepseek" | "searxng";
  results: SearchResult[];
}

export const DEFAULT_WEB_SEARCH: WebSearchConfig = {
  provider: "auto",
  searxng: {
    baseUrl: "",
    maxResults: 8,
    language: "",
    categories: "",
    timeoutMs: 8000,
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    count: 8,
    needContent: false,
    timeoutMs: 20000,
  },
};

const TOTAL_TEXT_LIMIT = 8000;
const SUMMARY_LIMIT = 480;
const SNIPPET_LIMIT = 220;
const CONTENT_LIMIT = 1200;

/** 深合并覆盖层与默认值;未知字段忽略,数值/枚举越界时钳制而不是炸配置 */
export function mergeWebSearch(raw: unknown): WebSearchConfig {
  const r = asObject(raw);
  const searxng = asObject(r.searxng);
  const deepseek = asObject(r.deepseek);
  return {
    provider: providerOf(r.provider),
    searxng: {
      baseUrl: str(searxng.baseUrl, DEFAULT_WEB_SEARCH.searxng.baseUrl),
      maxResults: clampInt(num(searxng.maxResults, DEFAULT_WEB_SEARCH.searxng.maxResults), 1, 20),
      language: str(searxng.language, DEFAULT_WEB_SEARCH.searxng.language).slice(0, 40),
      categories: str(searxng.categories, DEFAULT_WEB_SEARCH.searxng.categories).slice(0, 80),
      timeoutMs: clampInt(num(searxng.timeoutMs, DEFAULT_WEB_SEARCH.searxng.timeoutMs), 1000, 60_000),
    },
    deepseek: {
      baseUrl: str(deepseek.baseUrl, DEFAULT_WEB_SEARCH.deepseek.baseUrl),
      apiKey: str(deepseek.apiKey, DEFAULT_WEB_SEARCH.deepseek.apiKey),
      apiKeyEnv: str(deepseek.apiKeyEnv, DEFAULT_WEB_SEARCH.deepseek.apiKeyEnv),
      count: clampInt(num(deepseek.count, DEFAULT_WEB_SEARCH.deepseek.count), 1, 20),
      needContent: bool(deepseek.needContent, DEFAULT_WEB_SEARCH.deepseek.needContent),
      timeoutMs: clampInt(num(deepseek.timeoutMs, DEFAULT_WEB_SEARCH.deepseek.timeoutMs), 1000, 60_000),
    },
  };
}

export function deepseekApiKey(cfg: WebSearchConfig): string {
  const direct = cfg.deepseek.apiKey.trim();
  if (direct) return direct;
  const names = [cfg.deepseek.apiKeyEnv, "WATCHING_BOT_SEARCH_API_KEY", "DEEPSEEK_API_KEY"]
    .map((n) => n.trim())
    .filter(Boolean);
  for (const name of names) {
    const value = (process.env[name] ?? "").trim();
    if (value) return value;
  }
  return "";
}

/** auto 的判定顺序:DeepSeek key > SearXNG 地址;两者都没有就给出可执行的配置提示 */
export function resolveSearchProvider(cfg: WebSearchConfig): "deepseek" | "searxng" {
  if (cfg.provider === "deepseek") {
    if (!deepseekApiKey(cfg)) {
      throw new Error(
        "联网搜索配的是 DeepSeek,但没找到 API key:在 data/builtin.json 的 webSearch.deepseek.apiKey 填上,或设置 DEEPSEEK_API_KEY。",
      );
    }
    return "deepseek";
  }
  if (cfg.provider === "searxng") {
    if (!cfg.searxng.baseUrl.trim()) {
      throw new Error(
        "联网搜索配的是 SearXNG,但 webSearch.searxng.baseUrl 是空的:填实例地址(如 http://127.0.0.1:10099)。",
      );
    }
    return "searxng";
  }
  if (deepseekApiKey(cfg)) return "deepseek";
  if (cfg.searxng.baseUrl.trim()) return "searxng";
  throw new Error(
    "还没配置联网搜索:在面板 Builtin → 上网 里填 DeepSeek API key 或 SearXNG 地址,或写进 data/builtin.json 的 webSearch。",
  );
}

export function searchProviderInfo(cfg: WebSearchConfig): {
  provider: "deepseek" | "searxng" | null;
  detail: string;
} {
  try {
    return { provider: resolveSearchProvider(cfg), detail: "" };
  } catch (err) {
    return { provider: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runWebSearch(
  cfg: WebSearchConfig,
  params: SearchParams,
  log?: PluginLogger,
): Promise<SearchOutcome> {
  const query = params.query.trim();
  if (!query) throw new Error("搜索关键词不能为空。");
  if ([...query].length > 128) throw new Error("搜索关键词太长(最多 128 个字符)。");

  const provider = resolveSearchProvider(cfg);
  const fallbackCount = provider === "deepseek" ? cfg.deepseek.count : cfg.searxng.maxResults;
  const count = clampInt(params.count ?? fallbackCount, 1, 20);

  if (provider === "deepseek") {
    const results = await deepseekSearch(cfg, query, count, params.needContent ?? cfg.deepseek.needContent, log);
    return { provider, results };
  }
  const results = await searxngSearch(cfg, query, count, log);
  return { provider, results };
}

async function deepseekSearch(
  cfg: WebSearchConfig,
  query: string,
  count: number,
  needContent: boolean,
  log?: PluginLogger,
): Promise<SearchResult[]> {
  const key = deepseekApiKey(cfg);
  if (!key) throw new Error("DeepSeek 搜索缺少 API key。");
  const url = deepseekSearchUrl(cfg.deepseek.baseUrl);
  const body = JSON.stringify({ query, count, need_content: needContent });
  log?.debug(`[search] DeepSeek ${count} 条`);
  const payload = await fetchJson(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
        "user-agent": "watching-bot/0.2 (+web_search)",
      },
      body,
    },
    cfg.deepseek.timeoutMs,
    "DeepSeek 搜索",
  );

  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out: SearchResult[] = [];
  for (const row of rows) {
    const r = asObject(row);
    const resultUrl = str(r.url, "").trim();
    if (!isHttpUrl(resultUrl)) continue;
    out.push({
      title: str(r.title, resultUrl).trim() || resultUrl,
      url: resultUrl,
      snippet: str(r.snippet, "").trim(),
      summary: str(r.summary, "").trim() || undefined,
      content: needContent ? str(r.content, "").trim() || undefined : undefined,
      siteName: nullableStr(r.site_name) ?? safeHostname(resultUrl),
      date: nullableStr(r.date) ?? undefined,
      score: typeof r.rerank_score === "number" ? r.rerank_score : undefined,
    });
    if (out.length >= count) break;
  }
  return out;
}

async function searxngSearch(
  cfg: WebSearchConfig,
  query: string,
  count: number,
  log?: PluginLogger,
): Promise<SearchResult[]> {
  const endpoint = searxngSearchUrl(cfg.searxng.baseUrl);
  const url = new URL(endpoint);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", "1");
  if (cfg.searxng.language.trim()) url.searchParams.set("language", cfg.searxng.language.trim());
  if (cfg.searxng.categories.trim()) url.searchParams.set("categories", cfg.searxng.categories.trim());

  log?.debug(`[search] SearXNG ${count} 条`);
  const payload = await fetchJson(
    url.toString(),
    {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "watching-bot/0.2 (+web_search)",
      },
    },
    cfg.searxng.timeoutMs,
    "SearXNG 搜索",
  );

  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const out: SearchResult[] = [];
  for (const row of rows) {
    const r = asObject(row);
    const resultUrl = str(r.url, "").trim();
    if (!isHttpUrl(resultUrl)) continue;
    out.push({
      title: str(r.title, resultUrl).trim() || resultUrl,
      url: resultUrl,
      snippet: str(r.content, "").trim(),
      summary: undefined,
      content: undefined,
      siteName: safeHostname(resultUrl),
      date: nullableStr(r.publishedDate) ?? nullableStr(r.pubdate) ?? undefined,
      score: typeof r.score === "number" ? r.score : undefined,
    });
    if (out.length >= count) break;
  }
  return out;
}

export function formatSearchResults(query: string, outcome: SearchOutcome): string {
  const label = outcome.provider === "deepseek" ? "DeepSeek" : "SearXNG";
  if (outcome.results.length === 0) {
    return `「${query}」没有搜到结果(${label})。可以换个关键词,或去掉 site:/after: 这类限制再试。`;
  }
  const lines: string[] = [`「${query}」搜到 ${outcome.results.length} 条(${label}):`];
  let used = lines[0]!.length;
  let truncated = false;
  for (const [i, r] of outcome.results.entries()) {
    const block: string[] = [];
    block.push(`${i + 1}. ${truncate(r.title, 160)}`);
    block.push(`   ${r.url}`);
    const meta = [r.siteName, r.date].filter(Boolean).join(" · ");
    if (meta) block.push(`   ${truncate(meta, 120)}`);
    const body = r.summary || r.snippet;
    if (body) block.push(`   ${truncate(body, r.summary ? SUMMARY_LIMIT : SNIPPET_LIMIT)}`);
    if (r.content) block.push(`   正文: ${truncate(r.content, CONTENT_LIMIT)}`);
    const text = block.join("\n");
    if (used + text.length > TOTAL_TEXT_LIMIT) {
      truncated = true;
      break;
    }
    lines.push(text);
    used += text.length;
  }
  if (truncated) lines.push("…(结果较多,后面的先省了;要细看某条可以用浏览器类工具打开链接。)");
  else lines.push("要细看哪一条,可以用浏览器类工具打开它的链接。");
  return lines.join("\n");
}

export function buildWebSearchTool(getCfg: () => WebSearchConfig, log: PluginLogger): AgentTool {
  const params = Type.Object({
    query: Type.String({
      description: '搜索关键词;支持 site:example.com、after:2026、"精确短语"、-排除词 等语法',
    }),
    count: Type.Optional(
      Type.Number({ description: "要几条结果,默认按配置(通常 8),最多 20", minimum: 1, maximum: 20 }),
    ),
    needContent: Type.Optional(
      Type.Boolean({ description: "是否顺便取网页正文(只有 DeepSeek 后端支持;更慢、更占上下文)" }),
    ),
  });

  return {
    name: "web_search",
    label: "上网搜",
    description:
      "用搜索引擎查资料、新闻、攻略或某个站点的内容,返回标题、链接和摘要。搜到想细看的页面,再用浏览器类工具打开。",
    parameters: params,
    execute: async (_id, raw) => {
      const p = raw as { query: string; count?: number; needContent?: boolean };
      const outcome = await runWebSearch(getCfg(), p, log);
      return {
        content: [{ type: "text", text: formatSearchResults(p.query.trim(), outcome) }],
        details: {
          provider: outcome.provider,
          count: outcome.results.length,
          results: outcome.results.map((r) => ({ title: r.title, url: r.url })),
        },
      };
    },
  };
}

// ---------- 内部 ----------

function deepseekSearchUrl(baseUrl: string): string {
  const base = (baseUrl.trim() || DEFAULT_WEB_SEARCH.deepseek.baseUrl).replace(/\/+$/, "");
  if (/\/tools\/search$/.test(base)) return base;
  if (/\/v1$/.test(base)) return `${base}/tools/search`;
  return `${base}/v1/tools/search`;
}

function searxngSearchUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/search$/.test(base)) return base;
  return `${base}/search`;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort|timeout/i.test(msg)) throw new Error(`${label}超时(${timeoutMs}ms)。`);
    throw new Error(`${label}请求失败: ${msg}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const detail = truncate(redact(text), 300);
    if (res.status === 401) {
      throw new Error(`${label}鉴权失败(401):检查 API key。${detail ? ` ${detail}` : ""}`);
    }
    if (res.status === 402) throw new Error(`${label}账户余额不足(402)。`);
    if (res.status === 429) throw new Error(`${label}被限流了(429),过一会儿再试。`);
    throw new Error(`${label}返回 HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("响应不是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  } catch {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html") || /^\s*</.test(text)) {
      throw new Error(
        `${label}返回了 HTML 而不是 JSON。SearXNG 需要在 settings.yml 的 search.formats 里启用 json,然后重启实例。`,
      );
    }
    throw new Error(`${label}响应不是合法 JSON: ${truncate(redact(text), 200)}`);
  }
}

function redact(text: string): string {
  return text
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
    .replace(/(api[_-]?key|token)["']?\s*[:=]\s*["']?[^"',\s}]+/gi, "$1=***");
}

function providerOf(value: unknown): WebSearchConfig["provider"] {
  return value === "deepseek" || value === "searxng" ? value : "auto";
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function safeHostname(value: string): string | undefined {
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
}
