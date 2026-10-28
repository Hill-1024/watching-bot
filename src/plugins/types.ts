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

export type PluginPermission = "tools" | "perception" | "storage" | "realtime" | "config" | "llm-routing";

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
  /** LLM 路由控制(仅声明 llm-routing 权限的插件可见);用于把模型请求临时转到本地代理 */
  llm?: LlmRoutingControl;
  /** 通知面板本插件状态变化(topic 固定为 plugin:<id>,插件不能影响核心 topic) */
  publish?(data?: unknown): void;
  /** 摘要/工具变化后刷新模块总览,不改其它页面 */
  publishCatalog?(): void;
}

/**
 * LLM 路由控制:只允许「临时改写上游 baseUrl」这一种能力,不能读 key、不能改模型/provider。
 * 典型用途是可选插件(如 RTK proxy)在启用期间把请求接到本地优化代理,禁用即恢复。
 */
export interface LlmRoutingControl {
  /** 当前实际生效的上游地址(含已有 override) */
  currentBaseUrl(): string;
  /** 设置/清除路由覆盖(不写盘;失败返回 error,调用方应回退) */
  setRouteOverride(baseUrl: string | null): { ok: boolean; error?: string };
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
  error?: string;
}

export const PLUGIN_SCHEMA_VERSION = 1;
export const RESERVED_PLUGIN_IDS = new Set(["core", "system", "api", "plugins"]);
