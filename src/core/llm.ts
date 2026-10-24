import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { streamSimple as openaiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelConfig } from "../config.js";
import { modelApiKey } from "../config.js";

export interface LlmHandles {
  model: Model<"openai-completions">;
  streamFn: StreamFn;
}

/** 真实模型:自定义 OpenAI 兼容 provider(config 驱动,任何兼容端点可换) */
export function buildOpenAiCompatLlm(cfg: ModelConfig): LlmHandles {
  const apiKey = modelApiKey(cfg);
  const models: MutableModels = createModels();
  const provider = createProvider<"openai-completions">({
    id: "watching-bot-llm",
    name: "watching-bot LLM",
    baseUrl: cfg.baseUrl,
    auth: {
      apiKey: {
        name: "LLM API key",
        resolve: async () => (apiKey ? { auth: { apiKey } } : undefined),
      },
    },
    models: [
      {
        id: cfg.model,
        name: cfg.model,
        api: "openai-completions",
        provider: "watching-bot-llm",
        baseUrl: cfg.baseUrl,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        reasoning: false,
        contextWindow: cfg.contextWindow,
        maxTokens: 8192,
      },
    ],
    api: {
      "openai-completions": {
        stream: (model, context, options) =>
          openaiCompletionsStreamSimple(model as never, context, options),
        streamSimple: (model, context, options) =>
          openaiCompletionsStreamSimple(model as never, context, options),
      },
    },
  });
  models.setProvider(provider);
  const model = models.getModel("watching-bot-llm", cfg.model) as Model<"openai-completions">;
  const streamFn: StreamFn = (m, context, options) =>
    models.streamSimple(m as never, context, options);
  return { model, streamFn };
}
