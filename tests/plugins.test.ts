import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PluginHost } from "../src/plugins/host.js";
import { discoverPlugins } from "../src/plugins/manifest.js";
import { JsonPluginStorage } from "../src/plugins/storage.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix = "wb-plugins-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const DEFAULT_SERVER = `
export default async function start(ctx) {
  const starts = ctx.storage.get("starts", 0) + 1;
  ctx.storage.set("starts", starts);
  return {
    summary: "测试插件",
    tools: [{
      name: "fixture_tool",
      label: "fixture",
      description: "测试用工具",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    }],
    toolTags: { fixture_tool: ["social"] },
    status: () => ({ status: "ready" }),
    handle: (req) => ({ body: { path: req.path, starts } }),
    stop: async () => {},
  };
}
`;

function writePlugin(
  root: string,
  id: string,
  overrides: Record<string, unknown> = {},
  server = DEFAULT_SERVER,
): string {
  const dir = join(root, id);
  mkdirSync(join(dir, "server"), { recursive: true });
  const manifest = {
    schemaVersion: 1,
    id,
    name: id,
    version: "1.0.0",
    description: "fixture",
    entry: "./server/index.mjs",
    panel: { entry: "./panel/index.mjs", title: id, route: id, order: 10 },
    permissions: ["tools", "storage"],
    ...overrides,
  };
  writeFileSync(join(dir, "module.json"), JSON.stringify(manifest), "utf-8");
  writeFileSync(join(dir, "server/index.mjs"), server, "utf-8");
  mkdirSync(join(dir, "panel"), { recursive: true });
  writeFileSync(join(dir, "panel/index.mjs"), "export default { name: 'fixture' };", "utf-8");
  return dir;
}

function hostFor(root: string, dataDir: string, reservedToolNames: string[] = []) {
  return new PluginHost({
    pluginsRoot: root,
    dataDir,
    clock: { simNow: () => 1_000_000 },
    reservedToolNames,
  });
}

describe("插件 manifest 与发现", () => {
  it("仓库自带的 builtin / qq 插件都通过校验", () => {
    const { plugins, errors } = discoverPlugins("plugins");
    expect(errors).toEqual([]);
    const ids = plugins.map((p) => p.manifest.id).sort();
    expect(ids).toContain("builtin");
    expect(ids).toContain("qq");
    const qq = plugins.find((p) => p.manifest.id === "qq")!;
    expect(qq.manifest.runtimeAccess).toEqual(["napcat", "snowluma"]);
    expect(qq.panelEntryPath).toBeTruthy();
    const builtin = plugins.find((p) => p.manifest.id === "builtin")!;
    expect(builtin.manifest.panel?.route).toBe("builtin");
  });

  it("坏 manifest 只被跳过,不影响其他插件", () => {
    const root = tempDir();
    writePlugin(root, "good");
    const bad = join(root, "bad");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "module.json"), "{ not json", "utf-8");
    const { plugins, errors } = discoverPlugins(root);
    expect(plugins.map((p) => p.manifest.id)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
  });

  it("入口越出插件目录被拒绝", () => {
    const root = tempDir();
    writePlugin(root, "escape", { entry: "../outside.mjs" });
    writeFileSync(join(root, "outside.mjs"), "export default () => {};", "utf-8");
    const { plugins, errors } = discoverPlugins(root);
    expect(plugins).toHaveLength(0);
    expect(errors[0]?.message).toContain("插件目录内");
  });

  it("保留名与非法 id 被拒绝", () => {
    const root = tempDir();
    writePlugin(root, "core");
    writePlugin(root, "Bad_Id");
    const { plugins, errors } = discoverPlugins(root);
    expect(plugins).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it("插件 id 冲突只保留一个", () => {
    const root = tempDir();
    writePlugin(root, "dup");
    const second = join(root, "dup2");
    mkdirSync(join(second, "server"), { recursive: true });
    writeFileSync(
      join(second, "module.json"),
      JSON.stringify({
        schemaVersion: 1, id: "dup", name: "dup", version: "1", description: "d",
        entry: "./server/index.mjs",
      }),
      "utf-8",
    );
    writeFileSync(join(second, "server/index.mjs"), DEFAULT_SERVER, "utf-8");
    const { plugins, errors } = discoverPlugins(root);
    expect(plugins).toHaveLength(1);
    expect(errors.some((e) => e.message.includes("id 冲突"))).toBe(true);
  });
});

describe("插件生命周期与通用动作", () => {
  it("启动后工具进入 ModuleBus,停止后消失并触发 tools_changed", async () => {
    const root = tempDir();
    const data = tempDir("wb-plugin-data-");
    writePlugin(root, "alpha");
    const host = hostFor(root, data);
    const changed: string[] = [];
    host.onToolsChanged((id) => changed.push(id));

    await host.startOne("alpha");
    expect(host.allTools().map((t) => t.name)).toEqual(["fixture_tool"]);
    expect(host.toolTags("fixture_tool")).toEqual(["social"]);
    expect(host.capabilitySection()).toContain("测试插件");
    expect(changed).toEqual(["alpha"]);

    const res = await host.handle("alpha", { method: "GET", path: "", query: {}, body: null });
    expect(res.body).toMatchObject({ path: "", starts: 1 });

    const stopped = await host.stopOne("alpha");
    expect(stopped).toBe(true);
    expect(host.allTools()).toEqual([]);
    expect(changed).toEqual(["alpha", "alpha"]);
  });

  it("私有存储跨插件重启保留(咖啡余量这类状态不会重置)", async () => {
    const root = tempDir();
    const data = tempDir("wb-plugin-data-");
    writePlugin(root, "alpha");
    const first = hostFor(root, data);
    await first.startOne("alpha");
    await first.stopAll();

    const second = hostFor(root, data);
    await second.startOne("alpha");
    const res = await second.handle("alpha", { method: "GET", path: "", query: {}, body: null });
    expect(res.body).toMatchObject({ starts: 2 });
    await second.stopAll();
  });

  it("与核心工具重名时拒绝启动,并清理半初始化状态", async () => {
    const root = tempDir();
    const data = tempDir("wb-plugin-data-");
    writePlugin(root, "alpha");
    const host = hostFor(root, data, ["fixture_tool"]);
    await expect(host.startOne("alpha")).rejects.toThrow(/核心工具冲突/);
    expect(host.allTools()).toEqual([]);
  });

  it("两个插件工具同名时第二个拒绝启动", async () => {
    const root = tempDir();
    const data = tempDir("wb-plugin-data-");
    writePlugin(root, "alpha");
    writePlugin(root, "beta");
    const host = hostFor(root, data);
    await host.startOne("alpha");
    await expect(host.startOne("beta")).rejects.toThrow(/已被插件 alpha 占用/);
  });

  it("未启动插件的动作返回 409,未知插件 404/抛错", async () => {
    const root = tempDir();
    const data = tempDir("wb-plugin-data-");
    writePlugin(root, "alpha");
    const host = hostFor(root, data);
    const res = await host.handle("alpha", { method: "GET", path: "", query: {}, body: null });
    expect(res.status).toBe(409);
    await expect(host.handle("nope", { method: "GET", path: "", query: {}, body: null })).rejects.toThrow(/未找到插件/);
  });

  it("并发启动同一插件只执行一次(单飞)", async () => {
    const root = tempDir();
    const data = tempDir("wb-plugin-data-");
    writePlugin(root, "alpha");
    const host = hostFor(root, data);
    await Promise.all([host.startOne("alpha"), host.startOne("alpha"), host.startOne("alpha")]);
    const res = await host.handle("alpha", { method: "GET", path: "", query: {}, body: null });
    expect(res.body).toMatchObject({ starts: 1 });
    await host.stopAll();
  });
});

describe("插件静态资源边界", () => {
  it("只允许面板目录内的文件", async () => {
    const root = tempDir();
    const data = tempDir("wb-plugin-data-");
    const dir = writePlugin(root, "alpha");
    writeFileSync(join(dir, "secret.txt"), "nope", "utf-8");
    const host = hostFor(root, data);
    expect(host.panelDir("alpha")).toContain("panel");
    expect(host.assetPath("alpha", "secret.txt")).toBe(null);
    expect(host.assetPath("alpha", "../secret.txt")).toBe(null);
  });
});

describe("JsonPluginStorage", () => {
  it("原子写入并可跨实例读取", () => {
    const dir = tempDir("wb-storage-");
    const path = join(dir, "kv.json");
    const a = new JsonPluginStorage(path);
    a.set("coffee.remaining", 2);
    a.set("coffee.lastRefillDay", 9);
    const b = new JsonPluginStorage(path);
    expect(b.get("coffee.remaining", 0)).toBe(2);
    expect(b.all()).toEqual({ "coffee.remaining": 2, "coffee.lastRefillDay": 9 });
    b.delete("coffee.remaining");
    expect(new JsonPluginStorage(path).get("coffee.remaining", 7)).toBe(7);
  });
});
