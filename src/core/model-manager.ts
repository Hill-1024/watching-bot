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
  maxTokens?: number;
  /** off|minimal|low|medium|high|xhigh|max */
  thinkingLevel?: string;
}

export interface ModelView {
  faux: boolean;
  provider: string;
  model: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  thinkingLevel: string;
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

  /** 生效配置(覆盖层优先) */
  private effective(): ModelConfig {
    return {
      provider: this.override.provider ?? this.base.provider,
      model: this.override.model ?? this.base.model,
      baseUrl: this.override.baseUrl ?? this.base.baseUrl,
      apiKey: this.override.apiKey,
      apiKeyEnv: this.base.apiKeyEnv,
      contextWindow: this.override.contextWindow || this.base.contextWindow,
      maxTokens: this.override.maxTokens || this.base.maxTokens,
      thinkingLevel: this.override.thinkingLevel || this.base.thinkingLevel,
    };
  }

  /** 生效的 agent 推理档位(合法值之外回退 off) */
  thinkingLevel(): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" {
    const v = this.effective().thinkingLevel;
    const ok = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    return (ok.includes(v ?? "") ? v : "off") as never;
  }

  private rebuild(): void {
    this.handles = buildLlm(this.effective());
  }

  get current(): LlmHandles {
    if (this.handles == null) throw new Error("faux 模式下没有真实模型句柄");
    return this.handles;
  }

  /**
   * 当前生效模型的实际上下文窗口。
   * 优先取 pi 目录/自定义 provider 元数据(model.contextWindow),
   * 只有元数据缺失(自定义端点没填)时才回退到覆盖层或基础配置。
   * 这样热切换到一个 1M 窗口的模型后,压缩阈值立刻跟着变。
   */
  contextWindow(): number {
    const fromModel = Number((this.handles?.model as { contextWindow?: number } | undefined)?.contextWindow);
    if (Number.isFinite(fromModel) && fromModel > 0) return fromModel;
    const cfg = this.effective().contextWindow;
    return Number.isFinite(cfg) && cfg > 0 ? cfg : 128_000;
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
    if (typeof partial.maxTokens === "number" && partial.maxTokens > 0) merged.maxTokens = Math.round(partial.maxTokens);
    if (typeof partial.thinkingLevel === "string" && partial.thinkingLevel.trim() !== "") merged.thinkingLevel = partial.thinkingLevel.trim();
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
      contextWindow: this.contextWindow(),
      maxTokens: e.maxTokens ?? 8192,
      thinkingLevel: this.thinkingLevel(),
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
