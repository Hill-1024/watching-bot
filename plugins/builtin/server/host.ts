import { spawn, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PluginLogger } from "../../../src/plugins/types.js";

/**
 * 宿主能力:读文件、写文件、列目录、跑 shell。
 *
 * 这是「bot 直接跑在用户电脑上」时的基本 agent 能力,不依赖 Docker 或 MCP。
 * 默认把工作目录限制在当前项目根目录,禁止越界(可用 allowOutsideWorkdir 放开);
 * 输出与文件大小都有硬上限,避免一次工具调用把上下文打爆。
 *
 * 安全提示:shell 是真实的宿主命令执行,模型读到的聊天内容可能包含注入指令。
 * 只把 bot 接入可信的群/好友,或把 shellEnabled 关掉。
 */

export interface HostToolsConfig {
  enabled: boolean;
  /** 所有相对路径的基准目录;默认进程工作目录 */
  workdir: string;
  /** 允许读写/进入 workdir 之外的路径 */
  allowOutsideWorkdir: boolean;
  shellEnabled: boolean;
  /** run_shell 默认超时 */
  timeoutMs: number;
  /** 单次工具输出的字节上限 */
  maxOutputBytes: number;
  /** 单次读/写文件的字节上限 */
  maxFileBytes: number;
}

export const DEFAULT_HOST_TOOLS: HostToolsConfig = {
  enabled: true,
  workdir: ".",
  allowOutsideWorkdir: false,
  shellEnabled: true,
  timeoutMs: 60_000,
  maxOutputBytes: 128 * 1024,
  maxFileBytes: 5 * 1024 * 1024,
};

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "__pycache__", ".next", ".cache"]);
const MAX_LIST_ENTRIES = 400;
const MAX_LIST_DEPTH = 3;

export function mergeHostTools(raw: unknown): HostToolsConfig {
  const src = asObject(raw);
  const cfg: HostToolsConfig = { ...DEFAULT_HOST_TOOLS };
  if (typeof src.enabled === "boolean") cfg.enabled = src.enabled;
  if (typeof src.workdir === "string" && src.workdir.trim()) cfg.workdir = src.workdir.trim();
  if (typeof src.allowOutsideWorkdir === "boolean") cfg.allowOutsideWorkdir = src.allowOutsideWorkdir;
  if (typeof src.shellEnabled === "boolean") cfg.shellEnabled = src.shellEnabled;
  if (typeof src.timeoutMs === "number" && Number.isFinite(src.timeoutMs)) {
    cfg.timeoutMs = clampInt(src.timeoutMs, 1000, 600_000);
  }
  if (typeof src.maxOutputBytes === "number" && Number.isFinite(src.maxOutputBytes)) {
    cfg.maxOutputBytes = clampInt(src.maxOutputBytes, 1024, 4 * 1024 * 1024);
  }
  if (typeof src.maxFileBytes === "number" && Number.isFinite(src.maxFileBytes)) {
    cfg.maxFileBytes = clampInt(src.maxFileBytes, 1024, 64 * 1024 * 1024);
  }
  return cfg;
}

/** 面板 patch:只接受已知键,非法值抛错(由插件转成 400) */
export function patchHostTools(current: HostToolsConfig, patch: unknown): HostToolsConfig {
  const p = asObject(patch);
  const next: HostToolsConfig = { ...current };
  if (p.enabled !== undefined) {
    if (typeof p.enabled !== "boolean") throw new Error("hostTools.enabled 必须是布尔值");
    next.enabled = p.enabled;
  }
  if (p.workdir !== undefined) {
    if (typeof p.workdir !== "string" || !p.workdir.trim()) throw new Error("hostTools.workdir 不能为空");
    next.workdir = p.workdir.trim().slice(0, 500);
  }
  if (p.allowOutsideWorkdir !== undefined) {
    if (typeof p.allowOutsideWorkdir !== "boolean") throw new Error("hostTools.allowOutsideWorkdir 必须是布尔值");
    next.allowOutsideWorkdir = p.allowOutsideWorkdir;
  }
  if (p.shellEnabled !== undefined) {
    if (typeof p.shellEnabled !== "boolean") throw new Error("hostTools.shellEnabled 必须是布尔值");
    next.shellEnabled = p.shellEnabled;
  }
  for (const key of ["timeoutMs", "maxOutputBytes", "maxFileBytes"] as const) {
    const value = p[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`hostTools.${key} 必须是数字`);
    next[key] =
      key === "timeoutMs"
        ? clampInt(value, 1000, 600_000)
        : key === "maxOutputBytes"
          ? clampInt(value, 1024, 4 * 1024 * 1024)
          : clampInt(value, 1024, 64 * 1024 * 1024);
  }
  return next;
}

export function hostToolsView(cfg: HostToolsConfig): HostToolsConfig & { resolvedWorkdir: string } {
  return { ...cfg, resolvedWorkdir: resolve(cfg.workdir) };
}

export function buildHostTools(getConfig: () => HostToolsConfig, logger: PluginLogger): AgentTool[] {
  const readParams = Type.Object({
    path: Type.String({ description: "文件路径;相对路径从工作目录算" }),
    offset: Type.Optional(Type.Number({ description: "从第几行开始读(1 起),默认 1" })),
    limit: Type.Optional(Type.Number({ description: "最多读多少行,默认全部" })),
  });
  const readFileTool: AgentTool<typeof readParams> = {
    name: "read_file",
    label: "读文件",
    description:
      "读取宿主电脑上的一个文本文件。相对路径从工作目录算;可以带 offset/limit 只读一段。" +
      "二进制文件会被拒绝,过大的文件请分段读。",
    parameters: readParams,
    execute: async (_id, params: { path: string; offset?: number; limit?: number }) => {
      const cfg = getConfig();
      const abs = guardPath(cfg, params.path);
      const stat = statSync(abs);
      if (!stat.isFile()) throw new Error(`不是文件: ${params.path}`);
      if (stat.size > cfg.maxFileBytes) {
        throw new Error(`文件太大(${stat.size} 字节 > 上限 ${cfg.maxFileBytes}),请用 offset/limit 或 shell 处理`);
      }
      const buf = readFileSync(abs);
      if (buf.includes(0)) throw new Error("这是二进制文件,read_file 只能读文本");
      const text = buf.toString("utf-8");
      const lines = text.split(/\r?\n/);
      const offset = clampInt(params.offset ?? 1, 1, Math.max(lines.length, 1));
      const limit = params.limit == null ? lines.length - offset + 1 : clampInt(params.limit, 1, 20_000);
      const sliced = lines.slice(offset - 1, offset - 1 + limit);
      const truncated = offset - 1 + sliced.length < lines.length || offset > 1;
      const body = sliced.join("\n");
      logger.debug(`[host] read_file ${abs} (${sliced.length} 行)`);
      return {
        content: [
          {
            type: "text",
            text:
              (body || "(空文件)") +
              (truncated ? `\n\n[只显示第 ${offset}-${offset + sliced.length - 1} 行,共 ${lines.length} 行]` : ""),
          },
        ],
        details: { path: abs, bytes: stat.size, lines: lines.length, offset, returnedLines: sliced.length },
      };
    },
  };

  const writeParams = Type.Object({
    path: Type.String({ description: "文件路径;相对路径从工作目录算" }),
    content: Type.String({ description: "要写入的完整内容" }),
    append: Type.Optional(Type.Boolean({ description: "true = 追加到文件末尾;默认覆盖" })),
  });
  const writeFileTool: AgentTool<typeof writeParams> = {
    name: "write_file",
    label: "写文件",
    description:
      "把内容写入宿主电脑上的文件,自动创建父目录。默认整文件覆盖;append=true 时追加。" +
      "这是真实写盘,覆盖前先确认路径。",
    parameters: writeParams,
    execute: async (_id, params: { path: string; content: string; append?: boolean }) => {
      const cfg = getConfig();
      const abs = guardPath(cfg, params.path);
      const bytes = Buffer.byteLength(params.content, "utf-8");
      if (bytes > cfg.maxFileBytes) {
        throw new Error(`内容太大(${bytes} 字节 > 上限 ${cfg.maxFileBytes})`);
      }
      mkdirSync(dirname(abs), { recursive: true });
      if (params.append) {
        appendFileSync(abs, params.content, "utf-8");
      } else {
        const tmp = `${abs}.tmp-${process.pid}`;
        writeFileSync(tmp, params.content, "utf-8");
        renameSync(tmp, abs);
      }
      logger.info(`[host] write_file ${abs} (${bytes} 字节${params.append ? ",追加" : ""})`);
      return {
        content: [{ type: "text", text: `${params.append ? "已追加" : "已写入"} ${params.path}(${bytes} 字节)。` }],
        details: { path: abs, bytes, append: params.append === true },
      };
    },
  };

  const listParams = Type.Object({
    path: Type.Optional(Type.String({ description: "目录,默认工作目录" })),
    depth: Type.Optional(Type.Number({ description: `递归层数,默认 1,最多 ${MAX_LIST_DEPTH}` })),
    pattern: Type.Optional(Type.String({ description: "按名字过滤,支持 * ? 通配;不填列出全部" })),
  });
  const listFilesTool: AgentTool<typeof listParams> = {
    name: "list_files",
    label: "列目录",
    description:
      "列出一个目录里的文件和子目录,支持递归与通配过滤。默认跳过 .git/node_modules/dist 等噪音目录。",
    parameters: listParams,
    execute: async (_id, params: { path?: string; depth?: number; pattern?: string }) => {
      const cfg = getConfig();
      const base = guardPath(cfg, params.path ?? ".");
      const stat = statSync(base);
      if (!stat.isDirectory()) throw new Error(`不是目录: ${params.path ?? "."}`);
      const depth = clampInt(params.depth ?? 1, 1, MAX_LIST_DEPTH);
      const entries: string[] = [];
      walk(base, base, 0, depth, params.pattern, entries);
      entries.sort();
      const shown = entries.slice(0, MAX_LIST_ENTRIES);
      const more = entries.length > shown.length ? `\n[还有 ${entries.length - shown.length} 项未显示]` : "";
      return {
        content: [{ type: "text", text: (shown.join("\n") || "这个目录是空的。") + more }],
        details: { path: base, count: entries.length, shown: shown.length, depth },
      };
    },
  };

  const shellParams = Type.Object({
    command: Type.String({ description: "要执行的 shell 命令(Windows 是 cmd,Unix 是 sh)" }),
    cwd: Type.Optional(Type.String({ description: "工作目录,默认配置的 workdir" })),
    timeoutMs: Type.Optional(Type.Number({ description: "超时毫秒,默认配置值" })),
  });
  const runShellTool: AgentTool<typeof shellParams> = {
    name: "run_shell",
    label: "执行命令",
    description:
      "在宿主电脑上执行一条 shell 命令,返回退出码与 stdout/stderr。命令有超时与输出长度上限。" +
      "适合查看环境、运行脚本、git、下载文件等;破坏性命令请先确认。",
    parameters: shellParams,
    execute: async (_id, params: { command: string; cwd?: string; timeoutMs?: number }) => {
      const cfg = getConfig();
      if (!cfg.shellEnabled) throw new Error("shell 已被配置禁用(hostTools.shellEnabled=false)");
      const cwd = guardPath(cfg, params.cwd ?? ".");
      const timeoutMs = clampInt(params.timeoutMs ?? cfg.timeoutMs, 1000, cfg.timeoutMs);
      const started = Date.now();
      logger.info(`[host] run_shell cwd=${cwd} cmd=${params.command.slice(0, 200)}`);
      const result = await runCommand(params.command, cwd, timeoutMs, cfg.maxOutputBytes);
      const parts = [`exit code: ${result.code ?? "null"}${result.timedOut ? " (超时,已终止)" : ""}`];
      if (result.stdout.trim()) parts.push(`--- stdout ---\n${result.stdout.trimEnd()}`);
      if (result.stderr.trim()) parts.push(`--- stderr ---\n${result.stderr.trimEnd()}`);
      if (!result.stdout.trim() && !result.stderr.trim()) parts.push("(无输出)");
      return {
        content: [{ type: "text", text: parts.join("\n") }],
        details: {
          cwd,
          code: result.code,
          timedOut: result.timedOut,
          durationMs: Date.now() - started,
        },
      };
    },
  };

  const tools: AgentTool[] = [readFileTool, writeFileTool, listFilesTool];
  if (getConfig().shellEnabled) tools.push(runShellTool);
  return tools;
}

// ---------- 路径与输出 ----------

function guardPath(cfg: HostToolsConfig, input: string): string {
  const root = resolve(cfg.workdir);
  const abs = isAbsolute(input) ? resolve(input) : resolve(root, input);
  if (!cfg.allowOutsideWorkdir) {
    const rel = relative(root, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`路径越界: ${input}(工作目录是 ${root};需要访问外部路径请开 allowOutsideWorkdir)`);
    }
  }
  assertNotProtected(abs);
  return abs;
}

/** 少踩一个坑:不把 .env 里的 key 直接读给模型;.env.example 不拦 */
function assertNotProtected(abs: string): void {
  const name = basename(abs).toLowerCase();
  if (name.startsWith(".env") && name !== ".env.example" && name !== ".env.sample") {
    throw new Error(`拒绝访问 .env 文件: ${abs}`);
  }
  const segments = abs.split(/[\\/]+/).map((s) => s.toLowerCase());
  if (segments.includes(".git")) throw new Error(`拒绝访问 .git 目录: ${abs}`);
}

function walk(
  base: string,
  dir: string,
  level: number,
  maxDepth: number,
  pattern: string | undefined,
  out: string[],
): void {
  if (level >= maxDepth) return;
  let rows: Dirent[];
  try {
    rows = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const row of rows) {
    if (row.isDirectory() && SKIP_DIRS.has(row.name)) continue;
    const abs = resolve(dir, row.name);
    const rel = relative(base, abs).split(sep).join("/");
    if (matchName(row.name, pattern)) {
      out.push(row.isDirectory() ? `${rel}/` : `${rel} (${formatSize(safeSize(abs))})`);
    }
    if (row.isDirectory()) walk(base, abs, level + 1, maxDepth, pattern, out);
  }
}

function matchName(name: string, pattern: string | undefined): boolean {
  if (!pattern) return true;
  if (!/[*?]/.test(pattern)) return name.toLowerCase().includes(pattern.toLowerCase());
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );
  return re.test(name);
}

function safeSize(abs: string): number {
  try {
    return statSync(abs).size;
  } catch {
    return 0;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(command: string, cwd: string, timeoutMs: number, maxBytes: number): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const cap = maxBytes * 2;

    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < cap) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < cap) stderr += chunk;
    });

    const finish = (code: number | null, err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolvePromise({ code, stdout: truncate(stdout, maxBytes), stderr: truncate(stderr, maxBytes), timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // 极端情况下 taskkill 也可能杀不掉:兜底结束这次调用,别让 agent 永远卡住
      setTimeout(() => finish(null), 3000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (err) => finish(null, err));
    child.once("close", (code) => finish(code));
  });
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill("SIGKILL");
}

function truncate(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  const half = Math.floor(maxBytes / 2);
  return `${buf.subarray(0, half).toString("utf-8")}\n...[中间省略 ${buf.length - maxBytes} 字节]...\n${buf
    .subarray(buf.length - half)
    .toString("utf-8")}`;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
