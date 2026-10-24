import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildLlm, type LlmHandles } from "./llm.js";
import type { ModelConfig } from "../config.js";

export interface ModelOverride {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  contextWindow?: number;
}

export interface ModelView {
  faux: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  contextWindow: number;
  apiKeyEnv: string;
  apiKeySet: boolean;
  apiKeyMasked: string;
}

/**
 * 模型热切换管理:当前配置 = config/default.json 的 model 段 + data/model.json 覆盖层。
 * apply() 重建 pi 网关句柄(失败回滚),由 index.ts 把新句柄热替换到 pi Agent 上。
 */
export class ModelManager {
  private base: ModelConfig;
  private override: ModelOverride = {};
  private handles: LlmHandles | null = null;
  private readonly overridePath: string;

  constructor(
    base: ModelConfig,
    private readonly opts: { dataDir: string; log(msg: string): void; faux: boolean },
  ) {
    this.base = base;
    this.overridePath = resolve(opts.dataDir, "model.json");
    if (existsSync(this.overridePath)) {
      try {
        this.override = JSON.parse(readFileSync(this.overridePath, "utf-8")) as ModelOverride;
      } catch {
        this.opts.log("[model] data/model.json 解析失败,忽略覆盖层");
      }
    }
    if (!opts.faux) this.rebuild();
  }

  /** 覆盖层合并进基础配置后的生效配置 */
  private effective(): ModelConfig {
    return {
      provider: this.override.provider ?? this.base.provider,
      model: this.override.model ?? this.base.model,
      baseUrl: this.override.baseUrl ?? this.base.baseUrl,
      apiKey: this.override.apiKey,
      apiKeyEnv: this.base.apiKeyEnv,
      contextWindow: this.override.contextWindow || this.base.contextWindow,
    };
  }

  private rebuild(): void {
    this.handles = buildLlm(this.effective());
  }

  get current(): LlmHandles {
    if (this.handles == null) throw new Error("faux 模式下没有真实模型句柄");
    return this.handles;
  }

  /** 供 summarize/judge 注入 API key(pi 请求 options) */
  apiKey(): string | undefined {
    return this.effective().apiKey || process.env[this.base.apiKeyEnv] || undefined;
  }

  /** 应用一次覆盖(部分字段),失败自动回滚 */
  apply(partial: ModelOverride): { ok: boolean; error?: string } {
    if (this.opts.faux) return { ok: false, error: "faux 模式下不可切换模型(WATCHING_BOT_FAUX_LLM=1)" };
    const old = this.override;
    const merged: ModelOverride = { ...old };
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : undefined);
    const p = partial.provider !== undefined ? str(partial.provider) : undefined;
    const m = partial.model !== undefined ? str(partial.model) : undefined;
    const b = partial.baseUrl !== undefined ? str(partial.baseUrl) : undefined;
    if (p) merged.provider = p;
    if (m) merged.model = m;
    if (b !== undefined) merged.baseUrl = b; // 空串 = 清除,走 pi 目录
    if (typeof partial.apiKey === "string" && partial.apiKey.trim() !== "") merged.apiKey = partial.apiKey.trim();
    if (typeof partial.contextWindow === "number" && partial.contextWindow > 0) merged.contextWindow = Math.round(partial.contextWindow);
    this.override = merged;
    try {
      this.rebuild();
    } catch (err) {
      this.override = old;
      let rollbackNote = "";
      try {
        this.rebuild();
      } catch (err2) {
        rollbackNote = `(回滚也失败: ${String(err2)})`;
      }
      return { ok: false, error: `${String(err)}${rollbackNote}` };
    }
    try {
      mkdirSync(this.opts.dataDir, { recursive: true });
      writeFileSync(this.overridePath, JSON.stringify(this.override, null, 2), "utf-8");
    } catch (err) {
      this.opts.log(`[model] 覆盖层写盘失败(本次会话仍生效): ${String(err)}`);
    }
    this.opts.log(
      `[model] 已切换 → ${merged.provider ?? this.base.provider}/${merged.model ?? this.base.model}` +
        (merged.baseUrl ? ` @ ${merged.baseUrl}` : " (pi 目录端点)"),
    );
    return { ok: true };
  }

  view(): ModelView {
    const e = this.effective();
    const key = e.apiKey || process.env[this.base.apiKeyEnv] || "";
    return {
      faux: this.opts.faux,
      provider: e.provider,
      model: e.model,
      baseUrl: e.baseUrl,
      contextWindow: e.contextWindow,
      apiKeyEnv: this.base.apiKeyEnv,
      apiKeySet: key !== "",
      apiKeyMasked: key ? `${key.slice(0, 3)}••••${key.slice(-4)}` : "",
    };
  }

  /** pi 目录里的全部 provider id(面板下拉) */
  providers(): string[] {
    if (this.handles == null) return [];
    return this.handles.models
      .getProviders()
      .map((p) => p.id)
      .sort();
  }

  /** 某 provider 下的模型 id 列表 */
  modelsOf(providerId: string): string[] {
    if (this.handles == null) return [];
    return this.handles.models
      .getModels(providerId)
      .map((m) => m.id)
      .sort();
  }
}
