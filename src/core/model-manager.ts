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

/** 容器内访问宿主机服务的别名(Docker Desktop 默认提供;Linux 由 compose 的 extra_hosts 注入) */
const HOST_GATEWAY = "host.docker.internal";

/** 是否运行在容器里(用于判断 127.0.0.1 指的是容器还是宿主机) */
function inContainer(): boolean {
  return existsSync("/.dockerenv");
}

/**
 * 本地回环网关检测:容器里的 127.0.0.1/localhost 指向容器自身,永远连不到宿主机服务。
 * 这里不做静默改写(会让用户以为填对了),只做检测并把「应该填什么」讲清楚。
 */
export function isLoopbackGatewayUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

/** 容器内填回环地址时给出可执行的替代建议;非容器/非回环返回 null */
export function gatewayHint(url: string): string | null {
  if (!url || !inContainer() || !isLoopbackGatewayUrl(url)) return null;
  let port = "";
  try {
    port = new URL(url).port;
  } catch {
    // 忽略:URL 解析失败时只给通用建议
  }
  const suggested = `http://${HOST_GATEWAY}${port ? `:${port}` : ""}`;
  return `容器里的 127.0.0.1/localhost 指向容器自己,访问不到宿主机服务。请把 baseUrl 改成 ${suggested}(host.docker.internal 已在 compose 中配置,直接可用)。`;
}

/** 把回环网关地址替换成宿主机别名(供面板「一键替换」使用,不是静默行为) */
export function toHostGatewayUrl(url: string): string {
  return url.replace(/^(\w+:\/\/)(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?=[:/]|$)/i, `$1${HOST_GATEWAY}`);
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
  /** 当前配置不可用的原因(如容器内填了 127.0.0.1 网关);无问题为 null */
  warning: string | null;
  /** 覆盖层里原样保存的 baseUrl(可能与生效值不同,用于面板回显与一键修正) */
  configuredBaseUrl: string;
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
    const hint = this.override.baseUrl ? gatewayHint(this.override.baseUrl) : null;
    if (hint) {
      this.opts.log(`[model][warn] baseUrl 不可用:${hint}`);
    }
    if (!opts.faux) this.rebuild();
  }

  /** 生效配置(覆盖层优先;回环网关不静默改写,由 warning() 提示用户修正) */
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
    // 容器内的回环地址永远连不通宿主机:直接拒绝并给出可执行的替代值,而不是静默改写
    const loopbackHint = merged.baseUrl ? gatewayHint(merged.baseUrl) : null;
    if (loopbackHint) return { ok: false, error: loopbackHint };
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

  /** 当前配置的问题提示(baseUrl 回环等在容器里不可用的值);无问题返回 null */
  warning(): string | null {
    return gatewayHint(this.override.baseUrl ?? this.base.baseUrl);
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
      warning: this.warning(),
      configuredBaseUrl: this.override.baseUrl ?? "",
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
