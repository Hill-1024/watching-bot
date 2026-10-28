import { spawn, type ChildProcess } from "node:child_process";

/**
 * 最小 MCP 客户端:只实现 tools/list 与 tools/call 需要的 JSON-RPC。
 *
 * 两种标准传输:
 * - stdio:在本地拉起 MCP server(如 `obu mcp`),按行收发 JSON-RPC;
 * - SSE:MCP 的 HTTP+SSE 传输(用于 server 在另一台机器并已暴露 SSE 的场景)。
 *
 * 不做 OBU 专用逻辑——浏览器能力完全由 MCP server 的 tools 提供。
 */

export type JsonObject = Record<string, unknown>;

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: JsonObject;
}

export interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: {
    uri?: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export interface McpToolResult {
  content?: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClientInfo {
  name: string;
  version: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface Transport {
  readonly closed: boolean;
  start(onMessage: (msg: JsonObject) => void, onError: (err: Error) => void): Promise<void>;
  send(message: JsonObject): Promise<void> | void;
  close(): void;
}

export class McpRpc {
  private nextId = 1;
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly transport: Transport,
    private readonly timeoutMs = 30_000,
  ) {}

  get closed(): boolean {
    return this.transport.closed;
  }

  async connect(): Promise<void> {
    await this.transport.start(
      (msg) => this.handleMessage(msg),
      (err) => this.failAll(err),
    );
  }

  async initialize(clientInfo: McpClientInfo): Promise<JsonObject> {
    const result = await this.request<JsonObject>("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo,
    });
    this.notify("notifications/initialized", {});
    return result ?? {};
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await this.request<{ tools?: unknown; nextCursor?: unknown }>("tools/list", cursor ? { cursor } : {});
      const rows = Array.isArray(result?.tools) ? result.tools : [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const tool = row as JsonObject;
        if (typeof tool.name !== "string" || !tool.name) continue;
        tools.push({
          name: tool.name,
          title: typeof tool.title === "string" ? tool.title : undefined,
          description: typeof tool.description === "string" ? tool.description : undefined,
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
              ? (tool.inputSchema as JsonObject)
              : undefined,
        });
      }
      const next = typeof result?.nextCursor === "string" ? result.nextCursor : "";
      if (!next) break;
      cursor = next;
    }
    return tools;
  }

  async callTool(name: string, args: JsonObject): Promise<McpToolResult> {
    const result = await this.request<McpToolResult>("tools/call", { name, arguments: args });
    return result ?? {};
  }

  close(): void {
    this.failAll(new Error("MCP 连接已关闭"));
    this.transport.close();
  }

  private request<T>(method: string, params: JsonObject): Promise<T> {
    if (this.transport.closed) return Promise.reject(new Error("MCP 连接未建立"));
    const id = String(this.nextId++);
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 请求超时: ${method}`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    try {
      const sent = this.transport.send({ jsonrpc: "2.0", id, method, params });
      if (sent instanceof Promise) sent.catch((err) => this.rejectOne(id, err));
    } catch (err) {
      this.rejectOne(id, err);
    }
    return promise;
  }

  private notify(method: string, params: JsonObject): void {
    void this.transport.send({ jsonrpc: "2.0", method, params });
  }

  private handleMessage(msg: JsonObject): void {
    const id = typeof msg.id === "string" || typeof msg.id === "number" ? String(msg.id) : null;
    if (id) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (msg.error && typeof msg.error === "object") {
          const message = (msg.error as JsonObject).message;
          pending.reject(new Error(typeof message === "string" ? message : "MCP 请求失败"));
        } else {
          pending.resolve(msg.result ?? null);
        }
        return;
      }
    }

    // server → client 请求:只回最小能力,避免 server 等待
    if (typeof msg.method === "string" && id) {
      const method = msg.method;
      if (method === "ping") {
        void this.transport.send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "roots/list") {
        void this.transport.send({ jsonrpc: "2.0", id, result: { roots: [] } });
      } else {
        void this.transport.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `不支持的方法: ${method}` },
        });
      }
    }
  }

  private rejectOne(id: string, err: unknown): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.reject(err instanceof Error ? err : new Error(String(err)));
  }

  private failAll(err: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }
}

// ---------- stdio ----------

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  onLog?: (line: string) => void;
}

class StdioTransport implements Transport {
  private child: ChildProcess | null = null;
  private buffer = "";
  private closedFlag = true;
  private onMessage: ((msg: JsonObject) => void) | null = null;
  private onError: ((err: Error) => void) | null = null;

  constructor(private readonly opts: StdioTransportOptions) {}

  get closed(): boolean {
    return this.closedFlag;
  }

  async start(onMessage: (msg: JsonObject) => void, onError: (err: Error) => void): Promise<void> {
    this.onMessage = onMessage;
    this.onError = onError;
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env ?? {}) },
      shell: this.opts.shell === true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.closedFlag = false;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.handleData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.opts.onLog?.(line);
      }
    });
    child.once("error", (err) => {
      this.closedFlag = true;
      this.onError?.(new Error(`MCP stdio 启动失败: ${err.message}`));
    });
    child.once("exit", (code, signal) => {
      this.closedFlag = true;
      this.onError?.(new Error(`MCP stdio 进程退出(code=${code ?? "-"} signal=${signal ?? "-"})`));
    });
  }

  send(message: JsonObject): void {
    if (!this.child?.stdin || this.closedFlag) throw new Error("MCP stdio 未连接");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.closedFlag = true;
    const child = this.child;
    this.child = null;
    child?.stdin?.end();
    child?.kill();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.parseLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  private parseLine(line: string): void {
    try {
      const msg = JSON.parse(line) as JsonObject;
      if (msg && typeof msg === "object") this.onMessage?.(msg);
    } catch {
      // 非 JSON 行(日志)忽略
    }
  }
}

// ---------- SSE ----------

export interface SseTransportOptions {
  url: string;
  headers?: Record<string, string>;
  onLog?: (line: string) => void;
}

class SseTransport implements Transport {
  private controller: AbortController | null = null;
  private endpoint = "";
  private endpointReady: Promise<void> | null = null;
  private resolveEndpoint: (() => void) | null = null;
  private rejectEndpoint: ((err: Error) => void) | null = null;
  private closedFlag = true;
  private onMessage: ((msg: JsonObject) => void) | null = null;
  private onError: ((err: Error) => void) | null = null;

  constructor(private readonly opts: SseTransportOptions) {}

  get closed(): boolean {
    return this.closedFlag;
  }

  async start(onMessage: (msg: JsonObject) => void, onError: (err: Error) => void): Promise<void> {
    this.onMessage = onMessage;
    this.onError = onError;
    this.closedFlag = false;
    this.controller = new AbortController();
    this.endpointReady = new Promise<void>((resolve, reject) => {
      this.resolveEndpoint = resolve;
      this.rejectEndpoint = reject;
    });

    const res = await fetch(this.opts.url, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        "cache-control": "no-cache",
        ...(this.opts.headers ?? {}),
      },
      signal: this.controller.signal,
    });
    if (!res.ok) {
      this.closedFlag = true;
      throw new Error(`MCP SSE 连接失败: HTTP ${res.status}`);
    }
    if (!res.body) {
      this.closedFlag = true;
      throw new Error("MCP SSE 连接失败: 没有响应体");
    }

    void this.readLoop(res.body).catch((err) => {
      if (this.closedFlag) return;
      this.closedFlag = true;
      this.rejectEndpoint?.(err instanceof Error ? err : new Error(String(err)));
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("MCP SSE 等待 endpoint 超时")), 10_000);
      timer.unref?.();
    });
    await Promise.race([this.endpointReady, timeout]);
  }

  async send(message: JsonObject): Promise<void> {
    if (this.closedFlag) throw new Error("MCP SSE 未连接");
    await this.endpointReady;
    if (!this.endpoint) throw new Error("MCP SSE 没有 endpoint");
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.opts.headers ?? {}),
      },
      body: JSON.stringify(message),
    });
    if (!res.ok) throw new Error(`MCP SSE POST 失败: HTTP ${res.status}`);
    const text = await res.text();
    if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as JsonObject;
        if (parsed && typeof parsed === "object") this.onMessage?.(parsed);
      } catch {
        // 忽略非 JSON 的 POST 响应
      }
    }
  }

  close(): void {
    this.closedFlag = true;
    this.controller?.abort();
    this.controller = null;
    this.rejectEndpoint?.(new Error("MCP SSE 连接已关闭"));
  }

  private async readLoop(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        this.handleEvent(block);
        index = buffer.indexOf("\n\n");
      }
    }
    if (!this.closedFlag) {
      this.closedFlag = true;
      this.onError?.(new Error("MCP SSE 流已结束"));
    }
  }

  private handleEvent(block: string): void {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (data.length === 0) return;
    const payload = data.join("\n");
    if (event === "endpoint") {
      try {
        this.endpoint = new URL(payload, this.opts.url).toString();
        this.resolveEndpoint?.();
      } catch (err) {
        this.rejectEndpoint?.(err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }
    if (event !== "message") return;
    try {
      const msg = JSON.parse(payload) as JsonObject;
      if (msg && typeof msg === "object") this.onMessage?.(msg);
    } catch {
      this.opts.onLog?.(`无法解析 SSE 消息: ${payload.slice(0, 200)}`);
    }
  }
}

// ---------- 工厂 ----------

export function stdioClient(options: StdioTransportOptions & { timeoutMs?: number }): McpRpc {
  return new McpRpc(new StdioTransport(options), options.timeoutMs);
}

export function sseClient(options: SseTransportOptions & { timeoutMs?: number }): McpRpc {
  return new McpRpc(new SseTransport(options), options.timeoutMs);
}
