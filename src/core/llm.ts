import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createProvider,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { streamSimple as openaiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import type { ModelConfig } from "../config.js";

export interface LlmHandles {
  model: Model<any>;
  streamFn: StreamFn;
  /** pi 的模型网关(全量内置 provider 已注册;自定义端点会 setProvider 进来) */
  models: MutableModels;
}

/**
 * LLM 接入:直接复用 pi 的模型网关,不自研。
 *
 * 两条路径,由配置的 model.baseUrl 决定:
 * 1. 未配 baseUrl → pi 内置模型目录(30+ provider):`provider`/`model` 是 pi 目录里的
 *    id(如 deepseek/deepseek-chat、anthropic/claude-...),API key 走标准环境变量
 *    (OPENAI_API_KEY 等)或配置指定的 apiKeyEnv;
 * 2. 配了 baseUrl → 任意 OpenAI 兼容端点(GLM 大陆端点、自建网关、vLLM…),
 *    用 pi 的 createProvider + 内置 openai-completions 实现注册为一个新 provider,
 *    compat 怪癖由 pi 按 baseUrl 自动探测。
 *
 * 列出可用 provider:node -e "console.log(Object.keys(require('@earendil-works/pi-ai/dist/models.generated.js').MODELS))"
 */
export function buildLlm(cfg: ModelConfig): LlmHandles {
  const models: MutableModels = builtinModels();

  if (cfg.baseUrl) {
    const apiKey = cfg.apiKey || process.env[cfg.apiKeyEnv] || "";
    // baseUrl 以 /responses 结尾 = OpenAI Responses API(pi 内置实现,POST {baseUrl}/responses)
    const isResponses = /\/responses\/?$/.test(cfg.baseUrl);
    const baseUrl = isResponses ? cfg.baseUrl.replace(/\/responses\/?$/, "") : cfg.baseUrl;
    const apiId = isResponses ? "openai-responses" : "openai-completions";
    const impl = (
      model: never,
      context: never,
      options: never,
    ): ReturnType<typeof openaiCompletionsStreamSimple> =>
      (isResponses ? openaiResponsesStreamSimple : openaiCompletionsStreamSimple)(model, context, options) as never;
    models.setProvider(
      createProvider({
        id: "watching-bot-custom",
        name: `watching-bot(${new URL(baseUrl).host})`,
        baseUrl,
        auth: {
          apiKey: {
            name: cfg.apiKeyEnv,
            resolve: async () => (apiKey ? { auth: { apiKey } } : undefined),
          },
        },
        models: [
          {
            id: cfg.model,
            name: cfg.model,
            api: apiId as never,
            provider: "watching-bot-custom",
            baseUrl,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            reasoning: isResponses,
            contextWindow: cfg.contextWindow,
            maxTokens: cfg.maxTokens ?? 8192,
          },
        ],
        api: {
          [apiId]: {
            stream: (model: never, context: never, options: never) => impl(model, context, options),
            streamSimple: (model: never, context: never, options: never) => impl(model, context, options),
          },
        } as never,
      }),
    );
  }

  // 配了 baseUrl 时自定义端点是唯一事实来源,provider 字段不参与解析
  const providerId = cfg.baseUrl ? "watching-bot-custom" : cfg.provider;
  const model = models.getModel(providerId, cfg.model);
  if (!model) {
    const known = models.getProviders().map((p) => p.id).join(", ");
    throw new Error(
      `pi 模型网关里没有 ${providerId}/${cfg.model}。可用 provider:${known}。` +
        (cfg.baseUrl ? "" : ` 若为自建/未收录端点,请在配置里补 model.baseUrl(OpenAI 兼容)。`),
    );
  }

  const resolveApiKey = (): string | undefined =>
    cfg.apiKey || process.env[cfg.apiKeyEnv] || getEnvApiKey(cfg.provider) || undefined;

  const streamFn: StreamFn = (m, context, options) =>
    models.streamSimple(m as never, context, { ...options, apiKey: resolveApiKey() });

  return { model, streamFn, models };
}
