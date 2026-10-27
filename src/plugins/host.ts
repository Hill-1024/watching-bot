import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModuleBus, ModuleStatus, PerceptionEvent } from "../bus/types.js";
import { discoverPlugins, isInside, permissionsOf, runtimeAccessOf, type DiscoveredPlugin } from "./manifest.js";
import { JsonPluginStorage, pluginStoragePath } from "./storage.js";
import type {
  PluginContext,
  PluginHealth,
  PluginLogger,
  PluginRequest,
  PluginResponse,
  PluginView,
  RestrictedSupervisorClient,
  RunningPlugin,
} from "./types.js";

export interface PluginHostDeps {
  /** 插件根目录(默认仓库根下的 plugins/) */
  pluginsRoot: string;
  /** data 目录;插件私有存储落在 <dataDir>/plugins/<id>.json */
  dataDir: string;
  clock: { simNow(): number };
  log?: (msg: string) => void;
  moduleConfigs?: Record<string, unknown>;
  supervisor?: RestrictedSupervisorClient;
  /** 核心工具名:插件不得覆盖 */
  reservedToolNames?: string[];
  /** 事件推送(面板无需轮询);data 会原样进 SSE,供进度这种必须即时的信号使用 */
  publish?: (topic: string, data?: unknown) => void;
}

interface LoadedPlugin {
  descriptor: DiscoveredPlugin;
  instance: RunningPlugin;
  storage: JsonPluginStorage;
  health: PluginHealth;
  loadedAt: number;
}

/**
 * 插件宿主:发现、校验、启停、聚合工具、转发面板请求。
 *
 * 它对核心只暴露 ModuleBus(工具 + 能力段 + 感知),对 Web 只暴露 plugins()/handle();
 * 具体插件是谁、要什么配置、有什么页面,宿主一概不关心。
 */
export class PluginHost implements ModuleBus {
  private readonly discovered = new Map<string, DiscoveredPlugin>();
  private readonly loadErrors = new Map<string, string>();
  private readonly running = new Map<string, LoadedPlugin>();
  private readonly ops = new Map<string, Promise<unknown>>();
  private readonly reservedTools = new Set<string>();
  private perceptionCbs: ((e: PerceptionEvent) => void)[] = [];
  private toolsChangedCbs: ((pluginId: string) => void)[] = [];
  private readonly log: (msg: string) => void;
  private readonly moduleConfigs: Map<string, unknown>;

  constructor(private readonly deps: PluginHostDeps) {
    this.log = deps.log ?? (() => {});
    this.moduleConfigs = new Map(Object.entries(deps.moduleConfigs ?? {}));
    for (const name of deps.reservedToolNames ?? []) this.reservedTools.add(name);
    this.discover();
  }

  // ---------- 发现 ----------

  private discover(): void {
    const { plugins, errors } = discoverPlugins(this.deps.pluginsRoot);
    for (const p of plugins) {
      this.discovered.set(p.manifest.id, p);
      this.log(
        `[plugins] 发现 ${p.manifest.id} v${p.manifest.version}${p.manifest.panel ? ` (页面 ${p.manifest.panel.route})` : ""}`,
      );
    }
    for (const e of errors) {
      this.loadErrors.set(e.dir, e.message);
      this.log(`[plugins] 跳过 ${e.dir}: ${e.message}`);
    }
  }

  pluginIds(): string[] {
    return [...this.discovered.keys()].sort((a, b) => this.compareOrder(a, b));
  }

  private compareOrder(a: string, b: string): number {
    const ao = this.discovered.get(a)?.manifest.panel?.order ?? 1000;
    const bo = this.discovered.get(b)?.manifest.panel?.order ?? 1000;
    if (ao !== bo) return ao - bo;
    return a.localeCompare(b);
  }

  has(id: string): boolean {
    return this.discovered.has(id);
  }

  /** manifest 与运行态聚合视图(面板用) */
  plugins(): PluginView[] {
    return this.pluginIds().map((id) => this.view(id));
  }

  view(id: string): PluginView {
    const d = this.require(id);
    const loaded = this.running.get(id);
    const liveSummary = loaded ? loaded.instance.summary : undefined;
    return {
      id,
      name: d.manifest.name,
      version: d.manifest.version,
      description: d.manifest.description,
      summary: liveSummary ?? d.manifest.description,
      enabled: loaded != null,
      health: loaded ? this.healthNow(loaded.instance, loaded.health) : { status: "ready", detail: "stopped" },
      toolNames: (loaded?.instance.tools ?? []).map((t) => t.name).sort(),
      panel: d.manifest.panel
        ? { ...d.manifest.panel, url: this.panelUrl(id) ?? undefined }
        : undefined,
      permissions: permissionsOf(d.manifest),
      runtimeAccess: runtimeAccessOf(d.manifest),
      error: loaded?.health.status === "failed" ? loaded.health.detail : undefined,
    };
  }

  /** 面板入口(浏览器可请求的相对路径由 Web 层拼) */
  panelEntryPath(id: string): string | null {
    return this.discovered.get(id)?.panelEntryPath ?? null;
  }

  /** 面板入口所在目录:面板内部相对 import 以此为根 */
  panelDir(id: string): string | null {
    const entry = this.discovered.get(id)?.panelEntryPath;
    return entry ? dirname(entry) : null;
  }

  /** 浏览器可直接 import 的入口 URL(同源) */
  panelUrl(id: string): string | null {
    const d = this.discovered.get(id);
    if (!d?.panelEntryPath) return null;
    const rel = relative(dirname(d.panelEntryPath), d.panelEntryPath).split("\\").join("/");
    return `/plugins/${id}/panel/${rel}`;
  }

  /** 可选的静态资源目录(<pluginDir>/assets) */
  assetDir(id: string): string | null {
    const d = this.discovered.get(id);
    if (!d) return null;
    const dir = join(d.dir, "assets");
    return existsSync(dir) ? dir : null;
  }

  /** 静态资源白名单:只允许 <pluginDir>/assets 内的文件 */
  assetPath(id: string, relativePath: string): string | null {
    const dir = this.assetDir(id);
    if (!dir) return null;
    const target = resolve(dir, relativePath);
    if (!isInside(dir, target)) return null;
    return target;
  }

  // ---------- 生命周期 ----------

  async startAll(ids: string[]): Promise<void> {
    for (const id of ids) {
      if (!this.discovered.has(id)) {
        this.log(`[plugins] 配置里列了未发现的插件: ${id}`);
        continue;
      }
      try {
        await this.startOne(id);
      } catch (err) {
        this.log(`[plugins] 启动 ${id} 失败: ${String(err)}`);
      }
    }
  }

  startOne(id: string): Promise<boolean> {
    return this.serialize(`plugin:${id}`, async () => {
      if (this.running.has(id)) return true;
      const d = this.require(id);
      const log = this.loggerFor(id);
      const storage = new JsonPluginStorage(pluginStoragePath(this.deps.dataDir, id), log.warn);

      for (const perm of permissionsOf(d.manifest)) {
        if (perm === "realtime" && !this.deps.supervisor) {
          log.warn("声明了 realtime 权限,但当前没有可用的 supervisor");
        }
      }

      const ctx: PluginContext = {
        id,
        manifest: d.manifest,
        config: this.moduleConfigs.get(id) ?? {},
        dataDir: join(this.deps.dataDir, "plugins", id),
        simNow: () => this.deps.clock.simNow(),
        realNow: () => Date.now(),
        logger: log,
        storage,
        emitPerception: (e) => {
          for (const cb of this.perceptionCbs) cb(e);
        },
        supervisor: d.manifest.runtimeAccess?.length ? this.deps.supervisor : undefined,
        publish: (data?: unknown) => this.deps.publish?.(`plugin:${id}`, data),
        publishCatalog: () => this.deps.publish?.("plugins"),
      };

      let instance: RunningPlugin;
      try {
        instance = await this.loadModule(d.entryPath, ctx);
        this.assertNoToolConflicts(id, instance.tools ?? []);
      } catch (err) {
        // 实例没登记进 running,下次 start 会重新加载;不要为了“清理”去改插件存储
        throw err;
      }

      const loaded: LoadedPlugin = {
        descriptor: d,
        instance,
        storage,
        health: await this.healthOf(instance),
        loadedAt: Date.now(),
      };
      this.running.set(id, loaded);
      this.log(`[plugins] 已启动 ${id} (工具: ${(instance.tools ?? []).map((t) => t.name).join(", ") || "无"})`);
      this.emitToolsChanged(id);
      this.deps.publish?.("plugins");
      this.deps.publish?.(`plugin:${id}`);
      return true;
    });
  }

  stopOne(id: string): Promise<boolean> {
    return this.serialize(`plugin:${id}`, async () => {
      const loaded = this.running.get(id);
      if (!loaded) return false;
      this.running.delete(id);
      try {
        await loaded.instance.stop();
      } catch (err) {
        this.log(`[plugins] ${id} stop 失败: ${String(err)}`);
      }
      this.log(`[plugins] 已停止 ${id}`);
      this.emitToolsChanged(id);
      this.deps.publish?.("plugins");
      this.deps.publish?.(`plugin:${id}`);
      return true;
    });
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.running.keys()]) {
      await this.stopOne(id);
    }
  }

  private loadModule(entryPath: string, ctx: PluginContext): Promise<RunningPlugin> {
    return import(pathToUrl(entryPath)).then(async (mod: Record<string, unknown>) => {
      const start = mod.start ?? mod.default;
      if (typeof start !== "function") {
        throw new Error(`${entryPath} 必须导出 start(ctx) 或 default(ctx)`);
      }
      const instance = (await (start as (c: PluginContext) => Promise<RunningPlugin> | RunningPlugin)(ctx)) as RunningPlugin;
      if (!instance || typeof instance.stop !== "function") {
        throw new Error(`${entryPath} 的 start() 必须返回 { stop() }`);
      }
      return instance;
    });
  }

  private assertNoToolConflicts(id: string, tools: AgentTool[]): void {
    const local = new Set<string>();
    for (const tool of tools) {
      if (this.reservedTools.has(tool.name)) {
        throw new Error(`插件 ${id} 的工具名 "${tool.name}" 与核心工具冲突`);
      }
      if (local.has(tool.name)) {
        throw new Error(`插件 ${id} 内重复定义工具 "${tool.name}"`);
      }
      for (const [otherId, other] of this.running) {
        if (otherId === id) continue;
        if ((other.instance.tools ?? []).some((t) => t.name === tool.name)) {
          throw new Error(`插件 ${id} 的工具名 "${tool.name}" 已被插件 ${otherId} 占用`);
        }
      }
      local.add(tool.name);
    }
  }

  /** 同步 status() 每次现算,这样卡片上的实现名不会停在启动时那一次 */
  private healthNow(instance: RunningPlugin, cached: PluginHealth): PluginHealth {
    if (!instance.status) return cached;
    try {
      const value = instance.status();
      if (value instanceof Promise) return cached;
      return value;
    } catch (err) {
      return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private async healthOf(instance: RunningPlugin): Promise<PluginHealth> {
    if (!instance.status) return { status: "ready" };
    try {
      return await withTimeout(Promise.resolve(instance.status()), 3000, "status() 超时");
    } catch (err) {
      return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  // ---------- 面板请求转发 ----------

  async handle(id: string, req: PluginRequest): Promise<PluginResponse> {
    this.require(id);
    const loaded = this.running.get(id);
    if (!loaded) {
      return { status: 409, body: { error: `插件 ${id} 未启动` } };
    }
    if (!loaded.instance.handle) {
      return { status: 404, body: { error: `插件 ${id} 没有实现 handle()` } };
    }
    try {
      const res = await withTimeout(
        Promise.resolve(loaded.instance.handle(req)),
        15_000,
        `插件 ${id} 处理 ${req.path} 超时`,
      );
      return res;
    } catch (err) {
      this.log(`[plugins] ${id} handle(${req.path}) 失败: ${String(err)}`);
      return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
    }
  }

  // ---------- ModuleBus ----------

  allTools(): AgentTool[] {
    return [...this.running.values()].flatMap((p) => p.instance.tools ?? []);
  }

  toolTags(toolName: string): string[] {
    for (const p of this.running.values()) {
      const tags = p.instance.toolTags?.[toolName];
      if (tags) return tags;
    }
    return [];
  }

  capabilitySection(): string {
    const running = [...this.running.values()];
    if (running.length === 0) return "(当前没有接入任何外部能力插件)";
    return running
      .map((p) => `- ${p.instance.summary ?? p.descriptor.manifest.description}`)
      .join("\n");
  }

  status(): ModuleStatus[] {
    return [...this.running.values()].map((p) => ({
      name: p.descriptor.manifest.id,
      summary: p.instance.summary ?? p.descriptor.manifest.description,
      toolNames: (p.instance.tools ?? []).map((t) => t.name),
      started: true,
    }));
  }

  onPerception(cb: (e: PerceptionEvent) => void): void {
    this.perceptionCbs.push(cb);
  }

  /** 工具集变化(启停插件)→ 核心刷新 agent 工具与 capabilities 段 */
  onToolsChanged(cb: (pluginId: string) => void): void {
    this.toolsChangedCbs.push(cb);
  }

  private emitToolsChanged(pluginId: string): void {
    for (const cb of this.toolsChangedCbs) {
      try {
        cb(pluginId);
      } catch (err) {
        this.log(`[plugins] tools_changed 监听器异常: ${String(err)}`);
      }
    }
  }

  // ---------- 内部 ----------

  private require(id: string): DiscoveredPlugin {
    const d = this.discovered.get(id);
    if (!d) throw new Error(`未找到插件: ${id}`);
    return d;
  }

  private loggerFor(id: string): PluginLogger {
    const prefix = (level: string, msg: string) => this.log(`[${id}][${level}] ${msg}`);
    return {
      debug: (m) => prefix("debug", m),
      info: (m) => prefix("info", m),
      warn: (m) => prefix("warn", m),
      error: (m) => prefix("error", m),
    };
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.ops.set(key, next);
    void next.then(
      () => {
        if (this.ops.get(key) === next) this.ops.delete(key);
      },
      () => {
        if (this.ops.get(key) === next) this.ops.delete(key);
      },
    );
    return next;
  }
}

function pathToUrl(path: string): string {
  return pathToFileURL(path).href;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
