import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import start from "../plugins/builtin/server/index.js";
import { JsonPluginStorage } from "../src/plugins/storage.js";
import type { PluginContext } from "../src/plugins/types.js";

const dirs: string[] = [];
const servers: Server[] = [];

beforeEach(() => {
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("WATCHING_BOT_SEARCH_API_KEY", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-search-"));
  dirs.push(dir);
  return dir;
}

function ctxFor(dir: string, webSearch: unknown): PluginContext {
  return {
    id: "builtin",
    manifest: { schemaVersion: 1, id: "builtin", name: "Builtin", version: "1", description: "", entry: "" },
    config: {
      overrideFile: join(dir, "builtin.json"),
      master: { qq: 10001, name: "阿岚" },
      coffee: { dailyQuota: 3, refillSimHour: 8 },
      webSearch,
    },
    dataDir: dir,
    simNow: () => Date.UTC(2026, 9, 25, 12, 0, 0),
    realNow: () => Date.now(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    storage: new JsonPluginStorage(join(dir, "store.json")),
    emitPerception: () => {},
  };
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; server: Server }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, server };
}

function toolNamed(plugin: Awaited<ReturnType<typeof start>>, name: string) {
  const tool = plugin.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(`没有工具 ${name}`);
  return tool;
}

describe("builtin 插件:web_search", () => {
  it("SearXNG 后端解析结果并保留链接/摘要", async () => {
    const requests: { url: string; ua: string }[] = [];
    const { base } = await listen((req, res) => {
      requests.push({ url: req.url ?? "", ua: String(req.headers["user-agent"] ?? "") });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          results: [
            {
              title: "B站 首页",
              url: "https://www.bilibili.com/",
              content: "哔哩哔哩是一个视频社区。",
              publishedDate: "2026-01-02",
              engine: "brave",
              score: 1.2,
            },
            { title: "缺 url 的结果", content: "应被丢弃" },
          ],
        }),
      );
    });

    const plugin = await start(
      ctxFor(tempDir(), {
        provider: "searxng",
        searxng: { baseUrl: base },
      }),
    );
    const tool = toolNamed(plugin, "web_search");
    const r = (await tool.execute("t", { query: "bilibili 视频" } as never)) as {
      content: { text: string }[];
      details: { provider: string; count: number };
    };

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("/search?");
    expect(requests[0]!.url).toContain("format=json");
    expect(requests[0]!.ua).toContain("watching-bot");
    expect(r.details.provider).toBe("searxng");
    expect(r.details.count).toBe(1);
    expect(r.content[0]!.text).toContain("B站 首页");
    expect(r.content[0]!.text).toContain("https://www.bilibili.com/");
    expect(r.content[0]!.text).toContain("视频社区");
    await plugin.stop();
  });

  it("DeepSeek 后端按官方端点发请求并映射 summary/content", async () => {
    const seen: { auth: string; path: string; body: Record<string, unknown> }[] = [];
    const { base } = await listen((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        seen.push({
          auth: String(req.headers.authorization ?? ""),
          path: req.url ?? "",
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            results: [
              {
                title: "DeepSeek V4",
                url: "https://api-docs.deepseek.com/",
                snippet: "短摘要",
                summary: "给模型看的长摘要",
                content: "网页正文",
                site_name: "DeepSeek",
                date: "2026-06-01T00:00:00+00:00",
                rerank_score: 2.4,
              },
            ],
          }),
        );
      });
    });

    const plugin = await start(
      ctxFor(tempDir(), {
        provider: "deepseek",
        deepseek: { baseUrl: base, apiKey: "test-key", count: 5 },
      }),
    );
    const tool = toolNamed(plugin, "web_search");
    const r = (await tool.execute("t", { query: "DeepSeek V4", needContent: true } as never)) as {
      content: { text: string }[];
      details: { provider: string };
    };

    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/v1/tools/search");
    expect(seen[0]!.auth).toBe("Bearer test-key");
    expect(seen[0]!.body).toMatchObject({ query: "DeepSeek V4", count: 5, need_content: true });
    expect(r.details.provider).toBe("deepseek");
    expect(r.content[0]!.text).toContain("给模型看的长摘要");
    expect(r.content[0]!.text).toContain("网页正文");
    expect(r.content[0]!.text).toContain("DeepSeek");
    await plugin.stop();
  });

  it("auto 在有 DeepSeek key 时优先 DeepSeek", async () => {
    let hit = "";
    const { base } = await listen((req, res) => {
      hit = req.url ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ results: [] }));
    });

    const plugin = await start(
      ctxFor(tempDir(), {
        provider: "auto",
        searxng: { baseUrl: base },
        deepseek: { baseUrl: base, apiKey: "k" },
      }),
    );
    const tool = toolNamed(plugin, "web_search");
    const r = (await tool.execute("t", { query: "x" } as never)) as { details: { provider: string } };
    expect(r.details.provider).toBe("deepseek");
    expect(hit).toBe("/v1/tools/search");
    await plugin.stop();
  });

  it("没配置任何后端时给出可执行的提示", async () => {
    const plugin = await start(ctxFor(tempDir(), { provider: "auto" }));
    const tool = toolNamed(plugin, "web_search");
    await expect(tool.execute("t", { query: "x" } as never)).rejects.toThrow(/还没配置联网搜索/);
    await plugin.stop();
  });

  it("SearXNG 返回 HTML 时提示启用 json 格式", async () => {
    const { base } = await listen((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<html>settings</html>");
    });
    const plugin = await start(ctxFor(tempDir(), { provider: "searxng", searxng: { baseUrl: base } }));
    const tool = toolNamed(plugin, "web_search");
    await expect(tool.execute("t", { query: "x" } as never)).rejects.toThrow(/json/);
    await plugin.stop();
  });
});
