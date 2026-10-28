import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import start from "../plugins/builtin/server/index.js";
import { JsonPluginStorage } from "../src/plugins/storage.js";
import type { PluginContext } from "../src/plugins/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-host-"));
  dirs.push(dir);
  return dir;
}

function ctxFor(dir: string, hostTools: Record<string, unknown> = {}): PluginContext {
  return {
    id: "builtin",
    manifest: { schemaVersion: 1, id: "builtin", name: "Builtin", version: "1", description: "", entry: "" },
    config: {
      overrideFile: join(dir, "builtin.json"),
      master: { qq: 10001, name: "阿岚" },
      coffee: { dailyQuota: 3, refillSimHour: 8 },
      hostTools: { workdir: dir, ...hostTools },
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

type ToolResult = { content: { type: string; text?: string }[]; details: Record<string, unknown> };

describe("builtin 插件:宿主能力", () => {
  it("写入、读取、列目录都在 workdir 内", async () => {
    const dir = tempDir();
    const plugin = await start(ctxFor(dir));

    const written = (await toolNamed(plugin, "write_file").execute("t", {
      path: "notes/a.txt",
      content: "hello\nworld",
    } as never)) as ToolResult;
    expect(written.content[0]!.text).toContain("已写入");

    const read = (await toolNamed(plugin, "read_file").execute("t", {
      path: "notes/a.txt",
    } as never)) as ToolResult;
    expect(read.content[0]!.text).toBe("hello\nworld");

    const page = (await toolNamed(plugin, "read_file").execute("t", {
      path: "notes/a.txt",
      offset: 2,
      limit: 1,
    } as never)) as ToolResult;
    expect(page.content[0]!.text).toContain("world");
    expect(page.content[0]!.text).not.toContain("hello");

    const list = (await toolNamed(plugin, "list_files").execute("t", {
      path: ".",
      depth: 2,
      pattern: "*.txt",
    } as never)) as ToolResult;
    expect(list.content[0]!.text).toContain("notes/a.txt");

    await plugin.stop();
  });

  it("拒绝越界路径与 .env", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "SECRET=1", "utf-8");
    const plugin = await start(ctxFor(dir));

    await expect(
      toolNamed(plugin, "read_file").execute("t", { path: "../outside.txt" } as never),
    ).rejects.toThrow(/路径越界/);
    await expect(
      toolNamed(plugin, "read_file").execute("t", { path: ".env" } as never),
    ).rejects.toThrow(/拒绝访问 \.env/);

    await plugin.stop();
  });

  it("run_shell 返回真实输出与退出码", async () => {
    const dir = tempDir();
    const plugin = await start(ctxFor(dir));

    const result = (await toolNamed(plugin, "run_shell").execute("t", {
      command: `node -e "console.log('host-ok')"`,
    } as never)) as ToolResult;
    expect(result.content[0]!.text).toContain("host-ok");
    expect(result.content[0]!.text).toContain("exit code: 0");
    expect(result.details.code).toBe(0);

    await plugin.stop();
  });

  it("shellEnabled=false 时不注册 run_shell", async () => {
    const dir = tempDir();
    const plugin = await start(ctxFor(dir, { shellEnabled: false }));
    const names = plugin.tools!.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("run_shell");
    await plugin.stop();
  });
});
