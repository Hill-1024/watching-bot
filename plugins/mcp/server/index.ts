import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PluginContext, PluginHealth, PluginResponse, RunningPlugin } from "../../../src/plugins/types.js";
import {
  sseClient,
  stdioClient,
  type McpClientInfo,
  type McpContent,
  type McpRpc,
  type McpTool,
  type McpToolResult,
} from "./client.js";

/**
 * 标准 MCP 客户端插件:把外部 MCP server 的工具原样接给 agent。
 *
 * 这里没有浏览器/OBU/OCU 专用逻辑:
 *   - 本机 server:stdio 直接拉起进程(如 `obu mcp` / `ocu mcp`);
 *   - 远端 server:如果它自己暴露标准 MCP SSE,直接配 url 连接。
 *
 * 每次工具调用前都会检查连接:断了就重连并重新 initialize/tools-list,
 * 再执行这一次调用(stdio 会重新拉起 MCP server 进程)。
 *
 * 配置优先级:data/mcp.json(gitignored,本地覆盖)> config/default.json 的 moduleConfig.mcp。
 */

export interface McpServerConfig {
  id: string;
  enabled?: boolean;
  transport: "stdio" | "sse";
  /** stdio */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  /** sse */
  url?: string;
  headers?: Record<string, string>;
  /** 工具名前缀,默认 `${id}_` */
  toolPrefix?: string;
  timeoutMs?: number;
}

export interface McpConfig {
  overrideFile?: string;
  servers?: McpServerConfig[];
}

interface ServerState {
  id: string;
  transport: "stdio" | "sse";
  toolCount: number;
  tools: McpTool[];
  connection: ServerConnection;
  initialError?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OVERRIDE_FILE = "data/mcp.json";

export default async function start(ctx: PluginContext): Promise<RunningPlugin> {
  const cfg = loadConfig(ctx);
  const servers = (cfg.servers ?? []).filter((s) => s.enabled !== false);
  const states: ServerState[] = [];
  const tools: AgentTool[] = [];

  for (const server of servers) {
    const state = await connectServer(server, ctx);
    states.push(state);
    for (const tool of state.tools) {
      const agentTool = toAgentTool(server, tool, state, tools);
      if (agentTool) tools.push(agentTool);
    }
  }

  function serverView(s: ServerState): Record<string, unknown> {
    return {
      id: s.id,
      transport: s.transport,
      status: s.connection.connected ? "ready" : "failed",
      toolCount: s.toolCount,
      error: s.connection.connected ? undefined : (s.initialError ?? "未连接"),
    };
  }

  function view() {
    return {
      servers: states.map(serverView),
      tools: tools.map((t) => t.name).sort(),
    };
  }

  function status(): PluginHealth {
    if (servers.length === 0) return { status: "ready", detail: "未配置 MCP server" };
    const ready = states.filter((s) => s.connection.connected);
    const failed = states.filter((s) => !s.connection.connected);
    if (ready.length === servers.length) return { status: "ready" };
    const detail = failed
      .map((s) => `${s.id}: ${s.initialError ?? "未连接"}`)
      .join("; ");
    if (ready.length === 0) return { status: "failed", detail };
    return { status: "degraded", detail };
  }

  return {
    tools,
    summary: serverSummary(states, servers.length),
    status,
    handle: (req): PluginResponse => {
      if (`${req.method} ${req.path}` === "GET ") return { body: view() };
      return { status: 404, body: { error: `未知动作: ${req.method} ${req.path}` } };
    },
    stop: async () => {
      for (const state of states) state.connection.close();
    },
  };
}

// ---------- 连接(惰性重连) ----------

class ServerConnection {
  private rpc: McpRpc | null = null;
  private connecting: Promise<McpRpc> | null = null;
  tools: McpTool[] = [];

  constructor(
    private readonly server: McpServerConfig,
    private readonly ctx: PluginContext,
  ) {}

  get connected(): boolean {
    return this.rpc != null && !this.rpc.closed;
  }

  /** 调用前检查:没连接就建/拉起,已经连着就直接复用 */
  async ensure(): Promise<McpRpc> {
    if (this.connected) return this.rpc as McpRpc;
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<McpToolResult> {
    let rpc = await this.ensure();
    try {
      return await rpc.callTool(tool, args);
    } catch (err) {
      if (!isConnectionError(err)) throw err;
      this.ctx.logger.warn(
        `[mcp:${this.server.id}] 调用中断开,重连后重试 ${tool}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.close();
      rpc = await this.ensure();
      return rpc.callTool(tool, args);
    }
  }

  close(): void {
    this.rpc?.close();
    this.rpc = null;
  }

  private async connect(): Promise<McpRpc> {
    const rpc = createClient(this.server, this.ctx);
    try {
      await rpc.connect();
      await rpc.initialize(clientInfo());
      this.tools = await rpc.listTools();
      this.rpc = rpc;
      this.ctx.logger.info(`[mcp:${this.server.id}] ${this.server.transport} 已连接,${this.tools.length} 个工具`);
      return rpc;
    } catch (err) {
      rpc.close();
      throw err;
    }
  }
}

async function connectServer(server: McpServerConfig, ctx: PluginContext): Promise<ServerState> {
  const connection = new ServerConnection(server, ctx);
  let lastError = "连接失败";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await connection.ensure();
      return {
        id: server.id,
        transport: server.transport,
        toolCount: connection.tools.length,
        tools: connection.tools,
        connection,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      ctx.logger.warn(`[mcp:${server.id}] 连接失败(第 ${attempt + 1} 次): ${lastError}`);
      connection.close();
      if (attempt === 0) await sleep(1000);
    }
  }
  return {
    id: server.id,
    transport: server.transport,
    toolCount: 0,
    tools: [],
    connection,
    initialError: lastError,
  };
}

function createClient(server: McpServerConfig, ctx: PluginContext): McpRpc {
  const timeoutMs = clampInt(server.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1000, 120_000);
  if (server.transport === "sse") {
    if (!server.url) throw new Error("sse server 缺少 url");
    return sseClient({
      url: server.url,
      headers: server.headers,
      timeoutMs,
      onLog: (line) => ctx.logger.debug(`[mcp:${server.id}] ${line}`),
    });
  }
  if (!server.command) throw new Error("stdio server 缺少 command");
  return stdioClient({
    command: server.command,
    args: server.args,
    cwd: server.cwd ? resolve(server.cwd) : undefined,
    env: server.env,
    shell: server.shell,
    timeoutMs,
    onLog: (line) => ctx.logger.debug(`[mcp:${server.id}] ${line}`),
  });
}

function clientInfo(): McpClientInfo {
  return { name: "watching-bot", version: "0.2.0" };
}

function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /MCP (连接|请求超时)|未连接|流已结束|进程退出|连接已关闭|SSE 连接失败|POST 失败|stdio|ECONN|EPIPE|EHOSTUNREACH|ENOTFOUND|fetch failed/i.test(
    msg,
  );
}

// ---------- 工具映射 ----------

function toAgentTool(
  server: McpServerConfig,
  tool: McpTool,
  state: ServerState,
  existing: AgentTool[],
): AgentTool | null {
  const prefix = (server.toolPrefix ?? `${server.id}_`).trim();
  const base = `${prefix}${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  if (!base) return null;
  let name = base;
  for (let i = 2; existing.some((t) => t.name === name); i++) {
    name = `${base}_${i}`.slice(0, 64);
  }

  const schema =
    tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : undefined;

  return {
    name,
    label: tool.title || tool.name,
    description: `[MCP ${server.id}] ${tool.description || tool.title || tool.name}`,
    parameters: schema ? Type.Unsafe<Record<string, unknown>>(schema) : Type.Object({}),
    execute: async (_toolCallId, params) => {
      try {
        const result = await state.connection.call(tool.name, (params ?? {}) as Record<string, unknown>);
        return toAgentResult(server.id, tool.name, result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`MCP ${server.id}/${tool.name} 调用失败: ${msg}`);
      }
    },
  };
}

type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function toAgentResult(
  serverId: string,
  toolName: string,
  result: McpToolResult,
): AgentToolResult<Record<string, unknown>> {
  const content: ToolContent[] = [];
  for (const item of result.content ?? []) {
    const mapped = mapContent(item);
    if (mapped) content.push(mapped);
  }
  if (content.length === 0 && result.structuredContent !== undefined) {
    content.push({ type: "text", text: stringify(result.structuredContent) });
  }
  if (content.length === 0) {
    content.push({
      type: "text",
      text: result.isError ? "MCP 工具返回错误(没有内容)" : "MCP 工具没有返回内容",
    });
  }
  if (result.isError) {
    content.unshift({ type: "text", text: "MCP 工具报告错误(isError=true):" });
  }
  return {
    content,
    details: { server: serverId, tool: toolName, isError: result.isError === true },
  };
}

function mapContent(item: McpContent): ToolContent | null {
  if (!item || typeof item !== "object") return null;
  if (item.type === "text" && typeof item.text === "string") {
    return { type: "text", text: item.text };
  }
  if (item.type === "image" && typeof item.data === "string") {
    return { type: "image", data: item.data, mimeType: item.mimeType || "image/png" };
  }
  if (item.type === "resource" && item.resource) {
    const resource = item.resource;
    if (typeof resource.text === "string") {
      return { type: "text", text: resource.text };
    }
    if (typeof resource.blob === "string" && resource.mimeType?.startsWith("image/")) {
      return { type: "image", data: resource.blob, mimeType: resource.mimeType };
    }
    return { type: "text", text: stringify(resource) };
  }
  return { type: "text", text: stringify(item) };
}

// ---------- 配置 ----------

function loadConfig(ctx: PluginContext): McpConfig {
  const raw = asObject(ctx.config);
  const cfg: McpConfig = {
    overrideFile: typeof raw.overrideFile === "string" ? raw.overrideFile : DEFAULT_OVERRIDE_FILE,
    servers: normalizeServers(raw.servers),
  };
  const overridePath = resolve(cfg.overrideFile ?? DEFAULT_OVERRIDE_FILE);
  if (!existsSync(overridePath)) return cfg;
  try {
    const override = asObject(JSON.parse(readFileSync(overridePath, "utf-8")));
    if (override.servers !== undefined) {
      cfg.servers = normalizeServers(override.servers);
      ctx.logger.info(`[mcp] 使用 ${overridePath} 的 server 配置`);
    }
  } catch (err) {
    ctx.logger.warn(`[mcp] ${overridePath} 解析失败,忽略: ${String(err)}`);
  }
  return cfg;
}

function normalizeServers(raw: unknown): McpServerConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: McpServerConfig[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    const r = asObject(row);
    const id = typeof r.id === "string" ? r.id.trim().toLowerCase() : "";
    if (!id || !/^[a-z0-9-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const transport = r.transport === "stdio" || r.transport === "sse" ? r.transport : r.command ? "stdio" : "sse";
    out.push({
      id,
      enabled: r.enabled !== false,
      transport,
      command: typeof r.command === "string" ? r.command : undefined,
      args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : undefined,
      cwd: typeof r.cwd === "string" ? r.cwd : undefined,
      env: stringRecord(r.env),
      shell: r.shell === true,
      url: typeof r.url === "string" ? r.url.trim() : undefined,
      headers: stringRecord(r.headers),
      toolPrefix: typeof r.toolPrefix === "string" ? r.toolPrefix : undefined,
      timeoutMs: typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) ? r.timeoutMs : undefined,
    });
  }
  return out;
}

// ---------- 小工具 ----------

function serverSummary(states: ServerState[], configured: number): string {
  if (configured === 0) return "MCP:未配置 server";
  const parts = states.map((s) => {
    if (s.connection.connected) return `${s.id}(${s.toolCount}工具)`;
    return `${s.id}(失败)`;
  });
  return `标准 MCP 外部工具: ${parts.join(", ")}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) {
    if (typeof val === "string") out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
  });
}
