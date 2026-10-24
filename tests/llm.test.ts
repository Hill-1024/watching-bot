import { describe, expect, it } from "vitest";
import { buildLlm } from "../src/core/llm.js";

describe("llm 网关(复用 pi)", () => {
  it("路径一:目录 provider(deepseek/zai)直接从 pi 内置目录解析", () => {
    const ds = buildLlm({
      provider: "deepseek",
      baseUrl: "",
      model: "deepseek-flash",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      contextWindow: 0,
    });
    expect(ds.model.api).toBe("openai-completions");
    expect(ds.model.baseUrl).toContain("deepseek");
    expect(ds.model.contextWindow).toBeGreaterThan(0); // 目录自带窗口配置
    expect(ds.models.getProviders().length).toBeGreaterThan(10); // 全量内置 provider 都在

    // GLM 大陆端点 pi 目录原生就有,连 baseUrl 都不用配
    const zai = buildLlm({
      provider: "zai-coding-cn",
      baseUrl: "",
      model: "glm-5.3-flash",
      apiKeyEnv: "ZAI_API_KEY",
      contextWindow: 0,
    });
    expect(zai.model.baseUrl).toContain("open.bigmodel.cn");
  });

  it("路径二:自定义 OpenAI 兼容端点(GLM 开放平台)注册为自定义 provider", () => {
    const { model } = buildLlm({
      provider: "watching-bot-custom",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.7",
      apiKeyEnv: "WATCHING_BOT_API_KEY",
      contextWindow: 128000,
    });
    expect(model.baseUrl).toBe("https://open.bigmodel.cn/api/paas/v4");
    expect(model.api).toBe("openai-completions");
  });

  it("未知 provider/model 给出可诊断的错误", () => {
    expect(() =>
      buildLlm({ provider: "nope", baseUrl: "", model: "nope", apiKeyEnv: "X", contextWindow: 0 }),
    ).toThrow(/可用 provider/);
  });
});
