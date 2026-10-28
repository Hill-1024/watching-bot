import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import start from "../plugins/mcp/server/index.js";
import { JsonPluginStorage } from "../src/plugins/storage.js";
import type { PluginContext } from "../src/plugins/types.js";

const dirs: string[] = [];
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/mock-mcp-server.mjs");

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-mcp-"));
  dirs.push(dir);
  return dir;
}

function ctxFor(dir: string, config: Record<string, unknown>): PluginContext {
  return {
    id: "mcp",
    manifest: { schemaVersion: 1, id: "mcp", name: "MCP", version: "1", description: "", entry: "" },
    config: {
      overrideFile: join(dir, "mcp.json"),
      servers: [],
      ...config,
    },
    dataDir: dir,
    simNow: () => Date.UTC(2026, 9, 25, 12, 0, 0),
    realNow: () => Date.now(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    storage: new JsonPluginStorage(join(dir, "store.json")),
    emitPerception: () => {},
  };
}

function toolNamed(plugin: Awaited<ReturnType<typeof start>>, name: string) {
  const tool = plugin.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(`没有工具 ${name}`);
  return tool;
}

describe("mcp 插件:标准 stdio MCP", () => {
  it("发现工具并转发 tools/call(文本 + 图片)", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        servers: [
          {
            id: "mock",
            transport: "stdio",
            command: process.execPath,
            args: [fixture],
            toolPrefix: "mock_",
          },
        ],
      }),
    );

    const plugin = await start(ctxFor(dir, {}));
    expect(plugin.tools?.map((t) => t.name).sort()).toEqual(["mock_crash", "mock_echo", "mock_snap"]);
    expect(plugin.summary).toContain("mock(3工具)");
    expect(plugin.status?.()).toMatchObject({ status: "ready" });

    const echo = (await toolNamed(plugin, "mock_echo").execute("t", { text: "hi" } as never)) as {
      content: { type: string; text?: string }[];
    };
    expect(echo.content[0]).toMatchObject({ type: "text", text: "echo:hi" });

    const snap = (await toolNamed(plugin, "mock_snap").execute("t", {} as never)) as {
      content: { type: string; text?: string; data?: string; mimeType?: string }[];
    };
    expect(snap.content.some((c) => c.type === "text" && c.text === "snap ok")).toBe(true);
    expect(snap.content.some((c) => c.type === "image" && c.mimeType === "image/png")).toBe(true);

    // 让 MCP server 进程退出,下一次调用前应自动重新拉起并重试
    const crashed = (await toolNamed(plugin, "mock_crash").execute("t", {} as never)) as {
      content: { type: string; text?: string }[];
    };
    expect(crashed.content[0]).toMatchObject({ type: "text", text: "bye" });
    await new Promise((r) => setTimeout(r, 200));
    const again = (await toolNamed(plugin, "mock_echo").execute("t", { text: "again" } as never)) as {
      content: { type: string; text?: string }[];
    };
    expect(again.content[0]).toMatchObject({ type: "text", text: "echo:again" });

    await plugin.stop();
  });

  it("服务器起不来时不让插件崩,status 报 failed", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        servers: [
          {
            id: "dead",
            transport: "stdio",
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
          },
        ],
      }),
    );
    const plugin = await start(ctxFor(dir, {}));
    expect(plugin.tools).toEqual([]);
    expect(plugin.status?.().status).toBe("failed");
    await plugin.stop();
  });

  it("override 文件优先于 moduleConfig;工具名会加前缀/去重", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        servers: [
          { id: "mock", transport: "stdio", command: process.execPath, args: [fixture], toolPrefix: "x_" },
        ],
      }),
    );
    const plugin = await start(
      ctxFor(dir, {
        servers: [{ id: "ignored", transport: "stdio", command: "nope" }],
      }),
    );
    expect(plugin.tools?.map((t) => t.name).sort()).toEqual(["x_crash", "x_echo", "x_snap"]);
    await plugin.stop();
  });
});
