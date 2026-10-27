import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PerceptionEvent } from "../bus/types.js";

/**
 * 可信本地插件契约。
 *
 * 一个插件 = 一个目录 + 一个 module.json + 一个 server 入口(+ 可选 panel 入口)。
 * 内置插件与第三方插件走完全相同的契约:核心、Web 主路由、导航都不认识具体插件,
 * 只认识 manifest。新增插件不需要改 src/index.ts、web/server.ts 或前端 AppShell。
 *
 * 安全边界:插件是「安装即信任」的本地 Node.js / 浏览器代码,权限声明用于审计与
 * 约束宿主接口(例如只能操作白名单 runtime),不是沙箱。
 */

export type PluginPermission = "tools" | "perception" | "storage" | "realtime" | "config";

export type RuntimeId = "napcat" | "snowluma";

export interface PluginPanelDescriptor {
  /** 相对插件目录的入口(浏览器 ESM,导出 Vue defineComponent) */
  entry: string;
  title: string;
  icon?: string;
  /** 独立导航 route,如 "builtin" / "qq" */
  route: string;
  order?: number;
}

export interface PluginManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  /** 相对插件目录的 server 入口 */
  entry: string;
  configSchema?: string;
  panel?: PluginPanelDescriptor;
  permissions?: PluginPermission[];
  /** QQ 类插件可操作的白名单 runtime;只允许注册表 ID,不能传镜像/命令/路径 */
  runtimeAccess?: RuntimeId[];
}

export type PluginHealthStatus = "ready" | "degraded" | "failed";

export interface PluginHealth {
  status: PluginHealthStatus;
  detail?: string;
}

export interface PluginLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface PluginStorage {
  get<T>(key: string, fallback: T): T;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  all(): Record<string, unknown>;
}

/** 受限 supervisor 客户端:插件只能按 runtime ID 操作,不能直接碰 Docker */
export interface RestrictedSupervisorClient {
  list(): Promise<RuntimeStatusView[]>;
  inspect(id: RuntimeId): Promise<RuntimeStatusView>;
  install(id: RuntimeId): Promise<RuntimeStatusView>;
  start(id: RuntimeId): Promise<RuntimeStatusView>;
  stop(id: RuntimeId): Promise<RuntimeStatusView>;
  restart(id: RuntimeId): Promise<RuntimeStatusView>;
  recreate(id: RuntimeId, settings?: Record<string, unknown>): Promise<RuntimeStatusView>;
  logs(id: RuntimeId, tail?: number): Promise<string>;
  /** 读取 runtime 白名单内的配置文件(如 SnowLuma 的 onebot.json / vnc-password) */
  readFile(id: RuntimeId, key: string): Promise<string>;
}

export interface RuntimeStatusView {
  id: RuntimeId;
  install: "not_installed" | "pulling" | "installed" | "failed";
  process: "stopped" | "starting" | "running" | "restarting" | "error";
  image: string;
  containerName: string;
  hostPorts: Record<string, number>;
  health?: string;
  lastError?: string;
  operation?: { id: string; stage: string; progress?: number };
}

export interface PluginContext {
  id: string;
  manifest: PluginManifest;
  /** config/default.json 的 moduleConfig.<id> 段(已叠加敏感覆盖层) */
  config: unknown;
  /** 插件私有数据目录(data/plugins/<id>) */
  dataDir: string;
  simNow(): number;
  realNow(): number;
  logger: PluginLogger;
  storage: PluginStorage;
  emitPerception(event: PerceptionEvent): void;
  supervisor?: RestrictedSupervisorClient;
  /** 通知面板本插件状态变化(topic 固定为 plugin:<id>,插件不能影响核心 topic) */
  publish?(data?: unknown): void;
  /** 摘要/工具变化后刷新模块总览,不改其它页面 */
  publishCatalog?(): void;
}

export interface PluginRequest {
  method: string;
  /** actions/ 之后的路径,如 "" 表示插件状态,"coffee/grant" 表示具体动作 */
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface PluginResponse {
  status?: number;
  body: unknown;
}

export interface RunningPlugin {
  tools?: AgentTool[];
  toolTags?: Record<string, string[]>;
  /** 系统提示「可用能力」里的一句话;缺省用 manifest.description */
  summary?: string;
  status?(): PluginHealth | Promise<PluginHealth>;
  handle?(req: PluginRequest): Promise<PluginResponse> | PluginResponse;
  stop(): Promise<void>;
}

export interface PluginDefinition {
  start(ctx: PluginContext): Promise<RunningPlugin> | RunningPlugin;
}

/** 插件对面板暴露的视图(不含任何私有数据) */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  summary: string;
  enabled: boolean;
  health: PluginHealth;
  toolNames: string[];
  panel?: PluginPanelDescriptor & { url?: string };
  permissions: PluginPermission[];
  runtimeAccess: RuntimeId[];
  error?: string;
}

export const PLUGIN_SCHEMA_VERSION = 1;
export const RESERVED_PLUGIN_IDS = new Set(["core", "system", "api", "plugins"]);
