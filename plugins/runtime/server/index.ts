import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, resolve } from "node:path";
import type { PluginContext, PluginHealth, PluginResponse, RunningPlugin } from "../../../src/plugins/types.js";

/**
 * 本机组件运行时:开机只启动主框架,由主框架唤醒所有外部组件。
 *
 * 配置在 moduleConfig.runtime,或优先读 data/runtime.json(gitignored):
 *   {
 *     "ensureIntervalMs": 15000,
 *     "components": [
 *       {"id":"qq","command":"runtime/qq/Files/QQ.exe","cwd":"runtime/qq/Files",
 *        "check":{"process":"QQ.exe"}},
 *       {"id":"snowluma","command":"runtime/snowluma/node.exe","args":["index.mjs"],
 *        "cwd":"runtime/snowluma","check":{"port":5099},"delayMs":3000}
 *     ]
 *   }
 *
 * 判定「已经在跑」优先用 check(process / port),这样手工启动的进程也能被接管;
 * 已经运行时不重复拉起。进程退出后,下一轮 ensure 会重新唤醒。
 * 默认不接管停止:bot 重启/关闭时外部组件继续运行,数据与登录态不丢。
 */

export interface RuntimeComponentConfig {
  id: string;
  enabled?: boolean;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** 存活探测:进程名(Windows tasklist / Unix pgrep)或本地 TCP 端口 */
  check?: { process?: string; port?: number };
  /** 拉起前等待,给前置组件留启动时间 */
  delayMs?: number;
  /** 框架停止时是否一并结束该组件;默认 false(保留 QQ/SnowLuma 登录态) */
  stopOnExit?: boolean;
}

export interface RuntimeConfig {
  overrideFile?: string;
  ensureIntervalMs?: number;
  components?: RuntimeComponentConfig[];
}

interface ComponentState {
  cfg: RuntimeComponentConfig;
  child: ChildProcess | null;
  external: boolean;
  status: "unknown" | "running" | "starting" | "stopped" | "missing" | "failed";
  detail?: string;
  lastError?: string;
  lastStartAt?: number;
}

const DEFAULT_OVERRIDE_FILE = "data/runtime.json";
const DEFAULT_INTERVAL_MS = 15_000;
const MIN_INTERVAL_MS = 5_000;

export default async function start(ctx: PluginContext): Promise<RunningPlugin> {
  const cfg = loadConfig(ctx);
  const intervalMs = clampInt(cfg.ensureIntervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, 300_000);
  const states: ComponentState[] = [];

  for (const component of cfg.components ?? []) {
    const normalized = normalizeComponent(component);
    if (!normalized) continue;
    const st: ComponentState = { cfg: normalized, child: null, external: false, status: "unknown" };
    if (normalized.enabled === false) {
      st.status = "stopped";
      st.detail = "配置里已禁用";
    }
    states.push(st);
  }

  let ensuring = false;
  let stopped = false;

  const isRunning = async (st: ComponentState): Promise<boolean> => {
    const check = st.cfg.check;
    if (check?.port) return portOpen(check.port);
    if (check?.process) return processRunning(check.process);
    return st.child != null && st.child.exitCode == null;
  };

  const ensureOne = async (st: ComponentState): Promise<void> => {
    if (stopped || st.cfg.enabled === false) return;
    if (await isRunning(st)) {
      if (st.status !== "running") {
        st.status = "running";
        st.external = st.child == null;
        st.detail = st.external ? "外部进程已在运行" : "运行中";
        ctx.logger.info(`[runtime] ${st.cfg.id} ${st.detail}`);
      }
      return;
    }
    if (st.child && st.child.exitCode == null) {
      st.status = "starting";
      st.detail = "等待进程就绪";
      return;
    }

    const cwd = resolveCwd(st.cfg.cwd, ctx);
    if (st.cfg.delayMs) await sleep(st.cfg.delayMs);
    if (stopped) return;

    const command = resolveCommand(st.cfg.command);
    if (!command) {
      st.status = "missing";
      st.detail = `找不到可执行文件: ${st.cfg.command}`;
      ctx.logger.warn(`[runtime] ${st.cfg.id} ${st.detail}`);
      return;
    }

    try {
      const child = spawn(command, st.cfg.args ?? [], {
        cwd,
        env: { ...process.env, ...(st.cfg.env ?? {}) },
        stdio: "ignore",
        windowsHide: true,
        detached: process.platform !== "win32",
        shell: /\.(bat|cmd)$/i.test(command),
      });
      if (process.platform !== "win32") child.unref();
      st.child = child;
      st.external = false;
      st.status = "starting";
      st.detail = `已拉起 pid=${child.pid ?? "?"}`;
      st.lastStartAt = Date.now();
      ctx.logger.info(`[runtime] ${st.cfg.id} ${st.detail} (${command})`);

      child.once("error", (err) => {
        st.lastError = err.message;
        st.status = "failed";
        st.detail = `启动失败: ${err.message}`;
        st.child = null;
        ctx.logger.error(`[runtime] ${st.cfg.id} ${st.detail}`);
        ctx.publishCatalog?.();
      });
      child.once("exit", (code, signal) => {
        st.child = null;
        st.status = "stopped";
        st.detail = `已退出(code=${code ?? "-"} signal=${signal ?? "-"})`;
        ctx.logger.warn(`[runtime] ${st.cfg.id} ${st.detail};下一轮检查会重新唤醒`);
        ctx.publishCatalog?.();
      });

      // 给刚拉起的进程一点时间;端口/进程一旦就绪,状态立即从 starting 变 running
      await sleep(800);
      if (await isRunning(st)) {
        st.status = "running";
        st.detail = "运行中";
      }
    } catch (err) {
      st.lastError = err instanceof Error ? err.message : String(err);
      st.status = "failed";
      st.detail = `拉起失败: ${st.lastError}`;
      ctx.logger.error(`[runtime] ${st.cfg.id} ${st.detail}`);
    }
  };

  const refreshStatuses = async (): Promise<void> => {
    for (const st of states) {
      if (st.cfg.enabled === false || st.status === "missing") continue;
      if (await isRunning(st)) {
        st.status = "running";
        st.external = st.child == null;
        st.detail = st.external ? "外部进程已在运行" : "运行中";
      }
    }
  };

  const ensureAll = async (): Promise<void> => {
    if (ensuring || stopped) return;
    ensuring = true;
    try {
      for (const st of states) await ensureOne(st);
    } finally {
      ensuring = false;
      ctx.publishCatalog?.();
    }
  };

  const timer = setInterval(() => void ensureAll(), intervalMs);
  timer.unref?.();
  void ensureAll();

  const view = () => ({
    ensureIntervalMs: intervalMs,
    components: states.map((st) => ({
      id: st.cfg.id,
      enabled: st.cfg.enabled !== false,
      command: st.cfg.command,
      check: st.cfg.check,
      status: st.status,
      external: st.external,
      pid: st.child?.pid ?? null,
      lastStartAt: st.lastStartAt ?? null,
      detail: st.detail,
    })),
  });

  function status(): PluginHealth {
    if (states.length === 0) return { status: "ready", detail: "未配置本机组件" };
    const enabled = states.filter((s) => s.cfg.enabled !== false);
    const ready = enabled.filter((s) => s.status === "running").length;
    if (ready === enabled.length) return { status: "ready", detail: `${ready}/${enabled.length} 运行中` };
    const broken = enabled.filter((s) => s.status === "missing" || s.status === "failed");
    if (broken.length > 0) {
      return { status: "degraded", detail: broken.map((s) => `${s.cfg.id}: ${s.detail}`).join("; ") };
    }
    return { status: "degraded", detail: `${ready}/${enabled.length} 运行中` };
  }

  return {
    get summary() {
      if (states.length === 0) return "本机组件:未配置";
      const parts = states.map((s) => `${s.cfg.id}(${s.status === "running" ? "running" : s.status})`);
      return `本机组件: ${parts.join(", ")}`;
    },
    status,
    handle: async (req): Promise<PluginResponse> => {
      switch (`${req.method} ${req.path}`) {
        case "GET ":
          await refreshStatuses();
          return { body: view() };
        case "POST ensure":
          await ensureAll();
          return { body: { ok: true, state: view() } };
        default:
          return { status: 404, body: { error: `未知动作: ${req.method} ${req.path}` } };
      }
    },
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      for (const st of states) {
        if (st.cfg.stopOnExit && st.child && st.child.exitCode == null) {
          killTree(st.child);
          st.child = null;
        }
      }
    },
  };
}

// ---------- 配置 ----------

function loadConfig(ctx: PluginContext): RuntimeConfig {
  const raw = asObject(ctx.config);
  const cfg: RuntimeConfig = {
    overrideFile: typeof raw.overrideFile === "string" ? raw.overrideFile : DEFAULT_OVERRIDE_FILE,
    ensureIntervalMs:
      typeof raw.ensureIntervalMs === "number" && Number.isFinite(raw.ensureIntervalMs)
        ? raw.ensureIntervalMs
        : undefined,
    components: normalizeComponents(raw.components),
  };
  const path = resolve(cfg.overrideFile ?? DEFAULT_OVERRIDE_FILE);
  if (!existsSync(path)) return cfg;
  try {
    const override = asObject(JSON.parse(readFileSync(path, "utf-8")));
    if (override.components !== undefined) {
      cfg.components = normalizeComponents(override.components);
      ctx.logger.info(`[runtime] 使用 ${path} 的组件配置`);
    }
    if (typeof override.ensureIntervalMs === "number" && Number.isFinite(override.ensureIntervalMs)) {
      cfg.ensureIntervalMs = override.ensureIntervalMs;
    }
  } catch (err) {
    ctx.logger.warn(`[runtime] ${path} 解析失败,忽略: ${String(err)}`);
  }
  return cfg;
}

function normalizeComponents(raw: unknown): RuntimeComponentConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: RuntimeComponentConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const component = normalizeComponent(item);
    if (!component || seen.has(component.id)) continue;
    seen.add(component.id);
    out.push(component);
  }
  return out;
}

function normalizeComponent(raw: unknown): RuntimeComponentConfig | null {
  const r = asObject(raw);
  const id = typeof r.id === "string" ? r.id.trim().toLowerCase() : "";
  if (!id || !/^[a-z0-9-]+$/.test(id)) return null;
  const command = typeof r.command === "string" ? r.command.trim() : "";
  if (!command) return null;
  const checkRaw = asObject(r.check);
  const check: RuntimeComponentConfig["check"] = {};
  if (typeof checkRaw.process === "string" && checkRaw.process.trim()) check.process = checkRaw.process.trim();
  if (typeof checkRaw.port === "number" && Number.isInteger(checkRaw.port) && checkRaw.port > 0 && checkRaw.port <= 65535) {
    check.port = checkRaw.port;
  }
  return {
    id,
    enabled: r.enabled !== false,
    command,
    args: Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === "string") : undefined,
    cwd: typeof r.cwd === "string" && r.cwd.trim() ? r.cwd.trim() : undefined,
    env: stringRecord(r.env),
    check: check.process || check.port ? check : undefined,
    delayMs: typeof r.delayMs === "number" && Number.isFinite(r.delayMs) ? clampInt(r.delayMs, 0, 60_000) : undefined,
    stopOnExit: r.stopOnExit === true,
  };
}

// ---------- 进程/端口探测 ----------

function resolveCommand(command: string): string | null {
  if (!/[\\/]/.test(command) && !command.startsWith(".")) return command; // PATH 里的命令
  const abs = isAbsolute(command) ? command : resolve(process.cwd(), command);
  return existsSync(abs) ? abs : null;
}

function resolveCwd(cwd: string | undefined, ctx: PluginContext): string {
  if (!cwd) return process.cwd();
  const abs = isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
  if (!existsSync(abs)) {
    ctx.logger.warn(`[runtime] 工作目录不存在,改用项目根目录: ${abs}`);
    return process.cwd();
  }
  return abs;
}

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect({ port, host });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(ok);
    };
    socket.setTimeout(800, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function processRunning(name: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const command = process.platform === "win32" ? "tasklist" : "pgrep";
    const args = process.platform === "win32" ? ["/FI", `IMAGENAME eq ${name}`, "/NH"] : ["-f", name];
    execFile(command, args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolvePromise(false);
      resolvePromise(String(stdout).toLowerCase().includes(name.toLowerCase()));
    });
  });
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

// ---------- 小工具 ----------

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

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref?.();
  });
}
