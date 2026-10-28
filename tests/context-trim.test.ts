import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { trimForProtocol, trimOldToolResults } from "../src/core/agent.js";

function user(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 0 } as AgentMessage;
}
function toolResult(text: string, image = false): AgentMessage {
  const content: unknown[] = [{ type: "text", text }];
  if (image) content.push({ type: "image", data: "base64...", mimeType: "image/png" });
  return { role: "toolResult", content, timestamp: 0 } as AgentMessage;
}

describe("上下文工具结果分级裁剪", () => {
  it("最近 8 条完整保留,8-40 条截到 4k,更早截到 600 并省略图片", () => {
    const msgs: AgentMessage[] = [user("start")];
    // 50 条工具结果,每条 10k 字符
    for (let i = 0; i < 50; i++) msgs.push(toolResult("x".repeat(10_000) + `#${i}`, i % 3 === 0));
    const out = trimOldToolResults(msgs, 40);
    const textOf = (m: AgentMessage): string =>
      (m as { content: { type: string; text?: string }[] }).content.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
    // 最新一条完整
    expect(textOf(out[out.length - 1]!).length).toBeGreaterThan(9_000);
    // 8-40 条:截到 4k 左右
    const mid = out[msgs.length - 20]!;
    expect(textOf(mid).length).toBeLessThan(4_200);
    expect(textOf(mid)).toContain("省略");
    // 更早:截到 600 左右,且图片被替换为文本占位
    const old = out[5] as { content: { type: string; text?: string }[] };
    expect(textOf(old).length).toBeLessThan(700);
    expect(old.content.some((p) => p.type === "image")).toBe(false);
    expect(out[out.length - 1]).toBe(msgs[msgs.length - 1]); // 最新未改动
  });

  it("消息不超过 8 条时不改动", () => {
    const msgs = [user("a"), toolResult("y".repeat(20_000))];
    expect(trimOldToolResults(msgs, 40)).toBe(msgs);
  });
});

describe("协议裁剪与缓存对齐", () => {
  it("超长历史按块对齐切分,保留开头 system 与最近消息", () => {
    const msgs: AgentMessage[] = [{ role: "system", content: "persona", timestamp: 0 } as AgentMessage];
    for (let i = 0; i < 500; i++) {
      msgs.push(user(`u${i}`));
      msgs.push(toolResult(`r${i}`));
    }
    const out = trimForProtocol(msgs, 160);
    expect(out.length).toBeLessThan(260); // 最多多留一个块(50 条)
    expect((out[0] as { role: string }).role).toBe("system");
    expect((out[1] as { content?: string }).content).toContain("更早的");
    expect(JSON.stringify(out[out.length - 1])).toContain("r499");
  });

  it("切点在块内稳定(前缀不随单条新消息漂移)", () => {
    const mk = (n: number): AgentMessage[] => {
      const a: AgentMessage[] = [{ role: "system", content: "p", timestamp: 0 } as AgentMessage];
      for (let i = 0; i < n; i++) {
        a.push(user(`u${i}`));
        a.push(toolResult(`r${i}`));
      }
      return a;
    };
    const a = trimForProtocol(mk(400), 160);
    const b = trimForProtocol(mk(401), 160);
    // out[0]=system, out[1]=省略说明, out[2]=裁剪起点
    const firstUserA = (a[2] as { content?: string }).content;
    const firstUserB = (b[2] as { content?: string }).content;
    // 只加一条消息时,裁剪起点不应移动(块对齐的意义)
    expect(firstUserA).toBe(firstUserB);
  });
});
