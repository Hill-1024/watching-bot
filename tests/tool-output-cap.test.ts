import { describe, expect, it } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { capToolResultContent, capTools } from "../src/core/agent.js";

describe("工具输出裁剪(产生时一次,历史稳定)", () => {
  it("短输出原样保留", () => {
    const content = [{ type: "text", text: "hello" }];
    expect(capToolResultContent(content)).toEqual(content);
  });

  it("超长文本按上限截断并标注省略字数", () => {
    const content = [{ type: "text", text: "x".repeat(20_000) }];
    const out = capToolResultContent(content) as { type: string; text: string }[];
    expect(out[0]!.text.length).toBe(8_000);
    expect(out[1]!.text).toContain("已省略 12000 字");
  });

  it("多段文本共享同一个预算,图片原样保留", () => {
    const img = { type: "image", data: "b64", mimeType: "image/png" };
    const content = [
      { type: "text", text: "a".repeat(5_000) },
      { type: "text", text: "b".repeat(5_000) },
      img,
    ];
    const out = capToolResultContent(content) as { type: string; text?: string }[];
    const texts = out.filter((p) => p.type === "text").map((p) => p.text ?? "");
    expect(texts[0]!.length).toBe(5_000);
    expect(texts[1]!.length).toBe(3_000);
    expect(out.some((p) => p.type === "image")).toBe(true);
  });

  it("capTools 包装 execute,返回内容被裁剪,其余字段保留", async () => {
    const tool = {
      name: "big",
      label: "big",
      parameters: {},
      execute: async () => ({
        content: [{ type: "text", text: "y".repeat(10_000) }],
        details: { keep: true },
      }),
    } as unknown as AgentTool;
    const [wrapped] = capTools([tool]);
    const r = (await wrapped!.execute("id", {} as never)) as {
      content: { type: string; text: string }[];
      details: { keep: boolean };
    };
    expect(r.content[0]!.text.length).toBe(8_000);
    expect(r.details.keep).toBe(true);
  });
});
