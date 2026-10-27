import express from "express";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { SimClock } from "../core/clock.js";
import { HOUR, fmtSim } from "../core/clock.js";
import type { AgentCore } from "../core/loop.js";
import type { ModelManager, ModelOverride } from "../core/model-manager.js";
import { aggregateUsage, type UsageBucketUnit } from "../core/usage.js";
import type { StateChange } from "../state/changes.js";
import type { PluginHost } from "../plugins/host.js";
import { isInside } from "../plugins/manifest.js";
import { attachSse, statusSnapshot, type LiveHub } from "./live.js";
import type { Repo } from "../store/db.js";

export interface VarDef {
  min: number;
  max: number;
  init: number;
}

export interface PanelMemory {
  indexText(): string;
  indexPath(): string;
  diaryPath(dateIso: string): string;
  listDiaryDates(): string[];
  readDiary(dateIso: string): string | null;
}

/** 状态层只暴露只读诊断,面板不直接改内部结构 */
export interface PanelStateView {
  recentChanges(limit?: number): StateChange[];
  changesSince(after: number, limit?: number): { changes: StateChange[]; lastSeq: number; reset: boolean };
  pulseView(): { suppressedPerceptions: number; suppressedSocialTools: number };
}

export interface PanelDeps {
  clock: SimClock;
  core: AgentCore;
  plugins: PluginHost;
  state: PanelStateView;
  live: LiveHub;
  repo: Repo;
  modelManager: ModelManager;
  memory: PanelMemory;
  /** 状态变量上下限(面板钳制与渲染用) */
  varDefs: Record<string, VarDef>;
  /** 进程启动时间(真实 ms) */
  startedAt: number;
  /** 面板切换模型后,把新句柄热替换到 pi Agent(在 index.ts 闭包里做) */
  onModelChanged(): void;
  port: number;
  /** 监听地址:默认 loopback;容器内需要 0.0.0.0 */
  host?: string;
  token: string;
  log(msg: string): void;
}

const ACTIVITY_KINDS = ["thinking", "text", "tool_call", "tool_result", "error"] as const;

function numberParam(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(numberParam(v, fallback))));
}

function pageParams(req: express.Request, defaultSize = 50): { page: number; pageSize: number } {
  return {
    page: clampInt(req.query.page, 1, 1, 100_000),
    pageSize: clampInt(req.query.pageSize, defaultSize, 1, 200),
  };
}

function fileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Web 管理面板(读写):
 * - 看:实时状态、历史曲线、注入流水、活动日志、长期记忆、token 用量
 * - 管:直接改五维状态值、手动触发睡眠归并、强制醒/睡、热调 timeScale、模块启停、模型热切换
 * 全部经由核心命令 API,与状态管理器同级,不破坏 modules → bus ← core ← manager 依赖方向。
 */
export function startPanel(deps: PanelDeps): { stop(): void } {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const expected = deps.token ? Buffer.from(deps.token) : null;

  const tokenMatches = (candidate: string): boolean => {
    if (!expected) return true;
    const given = Buffer.from(candidate);
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  };

  const auth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const header = req.headers.authorization ?? "";
    const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
    // 兼容旧的 ?token= 传参(逐步淘汰),但绝不回写进 URL
    const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
    if (tokenMatches(bearer) || (fromQuery !== "" && tokenMatches(fromQuery))) {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return next();
    }
    res.status(401).json({ error: "unauthorized" });
  };

  /** 存活探针:进程在听即可,不含状态、不含秘密 */
  app.get("/healthz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true });
  });

  /** 就绪探针:时钟已走、数据库还能读。仍然不返回变量或 token */
  app.get("/readyz", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const sim = deps.clock.simNow();
      const bytes = deps.repo.fileBytes();
      if (!Number.isFinite(sim)) {
        res.status(503).json({ ok: false, reason: "clock" });
        return;
      }
      res.json({ ok: true, dbBytes: bytes });
    } catch {
      res.status(503).json({ ok: false, reason: "db" });
    }
  });

  app.get("/api/status", auth, (_req, res) => {
    const simMs = deps.clock.simNow();
    const snap = deps.core.snapshotNow();
    res.json({
      sim: fmtSim(simMs),
      simMs,
      realMs: Date.now(),
      startedAt: Math.round(deps.startedAt),
      timeScale: deps.clock.timeScale,
      phase: deps.core.machine.phase,
      sleepStartedSim: deps.core.machine.sleepStartedSim,
      snoozeCount: deps.core.machine.snoozeCount,
      pendingAlarms: deps.repo.pendingAlarmCount(),
      vars: snap.vars,
      defs: deps.varDefs,
      modules: deps.plugins.status(),
      plugins: deps.plugins.plugins(),
      statePulse: deps.state.pulseView(),
      activityLastSeq: deps.core.activityLastSeq(),
      memoryUpdatedAt: fileMtime(deps.memory.indexPath()),
      panel: { port: deps.port, authRequired: Boolean(deps.token) },
      dbBytes: deps.repo.fileBytes(),
    });
  });

  /** 事件推送(SSE):面板据此按 topic 更新,不做固定频率轮询 */
  app.get("/api/events", auth, (req, res) => {
    attachSse(req, res, deps.live, deps.log);
  });

  /** 状态变化因果链(增量拉取) */
  app.get("/api/state/changes", auth, (req, res) => {
    const after = numberParam(req.query.after, 0);
    const limit = clampInt(req.query.limit, 100, 1, 400);
    if (after > 0) {
      res.json(deps.state.changesSince(after, limit));
      return;
    }
    const changes = deps.state.recentChanges(limit);
    res.json({ changes, lastSeq: changes.at(-1)?.seq ?? 0, reset: false });
  });

  /** 状态历史:区间采样,修复旧版 since=0 永远返回最早 600 行的问题 */
  app.get("/api/history", auth, (req, res) => {
    const nowSim = deps.clock.simNow();
    const since = numberParam(req.query.since, nowSim - 6 * HOUR);
    const until = numberParam(req.query.until, nowSim + 1);
    const points = clampInt(req.query.points, 400, 50, 2000);
    if (!(until > since)) {
      res.status(400).json({ error: "until 必须大于 since" });
      return;
    }
    const rows = deps.repo.stateHistoryRange(since, until, points);
    const items = rows.map((r) => {
      let vars: Record<string, number> = {};
      try {
        vars = JSON.parse(r.vars) as Record<string, number>;
      } catch {
        // 旧行损坏时保持空对象,不拖垮整条曲线
      }
      return { tsSim: r.ts_sim, phase: r.phase, vars };
    });
    res.json({ since, until, items });
  });

  /** 注入流水:afterId=增量;page=分页;都不传=最近 80 条倒序 */
  app.get("/api/injections", auth, (req, res) => {
    const afterId = numberParam(req.query.afterId, 0);
    if (afterId > 0) {
      const limit = clampInt(req.query.limit, 100, 1, 500);
      const items = deps.repo.injectionsAfter(afterId, limit);
      res.json({ items, lastId: items.at(-1)?.id ?? afterId });
      return;
    }
    const { page, pageSize } = pageParams(req, 80);
    const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
    const r = deps.repo.injectionPage({ page, pageSize, channel });
    res.json({ items: r.items, total: r.total, page, pageSize });
  });

  /** 活动日志:实时增量(内存环形缓冲) */
  app.get("/api/activity", auth, (req, res) => {
    const after = numberParam(req.query.after, 0);
    res.json({ ...deps.core.activitySince(after), now: Date.now() });
  });

  /** 活动日志:历史分页(持久化在 SQLite) */
  app.get("/api/activity/history", auth, (req, res) => {
    const { page, pageSize } = pageParams(req, 50);
    const kindsRaw = typeof req.query.kinds === "string" ? req.query.kinds.split(",") : [];
    const kinds = kindsRaw.filter((k): k is (typeof ACTIVITY_KINDS)[number] =>
      (ACTIVITY_KINDS as readonly string[]).includes(k),
    );
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    const r = deps.repo.activityPage({ page, pageSize, kinds, query: q });
    res.json({
      items: r.items.map((a) => ({
        id: a.id,
        tsSim: a.tsSim,
        tsReal: a.tsReal,
        kind: a.kind,
        text: a.text,
      })),
      total: r.total,
      page,
      pageSize,
    });
  });

  app.post("/api/vars", auth, (req, res) => {
    const { name, value } = req.body as { name?: string; value?: number };
    if (typeof name !== "string" || typeof value !== "number" || !Number.isFinite(value)) {
      res.status(400).json({ error: "需要 { name, value }" });
      return;
    }
    const def = deps.varDefs[name];
    if (!def) {
      res.status(400).json({ error: `未知状态变量: ${name}` });
      return;
    }
    const clamped = Math.max(def.min, Math.min(def.max, value));
    const snap = deps.core.applyState({ type: "setVar", name, value: clamped });
    deps.live.publish("state");
    deps.live.publish("status", statusSnapshot({ clock: deps.clock, core: deps.core, state: deps.state }));
    deps.log(`[panel] 状态调整 ${name} = ${clamped}`);
    res.json({ ok: true, vars: snap.vars, applied: snap.vars[name], clamped: clamped !== value });
  });

  app.post("/api/consolidate", auth, async (_req, res) => {
    deps.log("[panel] 手动触发睡眠归并");
    try {
      await deps.core.runConsolidation();
      deps.live.publish("memory");
      deps.live.publish("status", statusSnapshot({ clock: deps.clock, core: deps.core, state: deps.state }));
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/sleep", auth, (_req, res) => {
    deps.core.requestSleep("panel");
    deps.live.publish("status", statusSnapshot({ clock: deps.clock, core: deps.core, state: deps.state }));
    res.json({ ok: true });
  });

  app.post("/api/wake", auth, (_req, res) => {
    deps.core.forceWake("panel");
    deps.live.publish("status", statusSnapshot({ clock: deps.clock, core: deps.core, state: deps.state }));
    res.json({ ok: true });
  });

  app.post("/api/timescale", auth, (req, res) => {
    const { value } = req.body as { value?: number };
    if (typeof value !== "number" || !(value > 0) || value > 100_000) {
      res.status(400).json({ error: "value 需为正数且不超过 100000" });
      return;
    }
    deps.clock.setTimeScale(value);
    deps.live.publish("status", statusSnapshot({ clock: deps.clock, core: deps.core, state: deps.state }));
    deps.log(`[panel] timeScale → ${value}`);
    res.json({ ok: true, timeScale: value });
  });

  // ---------- 插件(通用,主服务不包含任何插件业务知识) ----------

  app.get("/api/plugins", auth, (_req, res) => {
    res.json({ plugins: deps.plugins.plugins() });
  });

  app.get("/api/plugins/:id", auth, (req, res) => {
    const id = (req.params.id ?? "");
    if (!deps.plugins.has(id)) {
      res.status(404).json({ error: `未找到插件: ${id}` });
      return;
    }
    res.json(deps.plugins.view(id));
  });

  app.post("/api/plugins/:id/start", auth, async (req, res) => {
    const id = (req.params.id ?? "");
    if (!deps.plugins.has(id)) {
      res.status(404).json({ error: `未找到插件: ${id}` });
      return;
    }
    try {
      await deps.plugins.startOne(id);
      res.json({ ok: true, plugin: deps.plugins.view(id) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/plugins/:id/stop", auth, async (req, res) => {
    const id = (req.params.id ?? "");
    if (!deps.plugins.has(id)) {
      res.status(404).json({ error: `未找到插件: ${id}` });
      return;
    }
    try {
      const stopped = await deps.plugins.stopOne(id);
      res.json({ ok: stopped, plugin: deps.plugins.view(id) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  /**
   * 通用动作转发:主服务只做鉴权、路径/大小校验和插件查找,
   * 不认识「咖啡」或「runtime 切换」这类业务。
   */
  app.all("/api/plugins/:id/actions/*", auth, async (req, res) => {
    const id = (req.params.id ?? "");
    if (!deps.plugins.has(id)) {
      res.status(404).json({ error: `未找到插件: ${id}` });
      return;
    }
    const action = (req.params as Record<string, string>)[0] ?? "";
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === "string") query[k] = v.slice(0, 200);
    }
    const result = await deps.plugins.handle(id, {
      method: req.method,
      path: action,
      query,
      body: req.body,
    });
    res.status(result.status ?? 200).json(result.body);
  });

  // ---------- 模型配置(热切换) ----------

  app.get("/api/model", auth, (_req, res) => {
    res.json({ ...deps.modelManager.view(), providers: deps.modelManager.providers() });
  });

  app.get("/api/model/catalog", auth, (req, res) => {
    const provider = typeof req.query.provider === "string" ? req.query.provider : "";
    if (!provider) {
      res.status(400).json({ error: "需要 provider 参数" });
      return;
    }
    res.json({ provider, models: deps.modelManager.modelsOf(provider) });
  });

  app.post("/api/model", auth, (req, res) => {
    const body = req.body as ModelOverride;
    const r = deps.modelManager.apply(body);
    if (!r.ok) {
      res.status(400).json(r);
      return;
    }
    deps.onModelChanged();
    deps.live.publish("model");
    res.json({ ok: true, model: deps.modelManager.view() });
  });

  // ---------- 长期记忆(摘要) ----------

  app.get("/api/memory", auth, (_req, res) => {
    const dates = deps.memory.listDiaryDates().slice(-60).reverse();
    const diaries = dates.flatMap((date) => {
      const path = deps.memory.diaryPath(date);
      if (!existsSync(path)) return [];
      const st = statSync(path);
      const text = deps.memory.readDiary(date) ?? "";
      return [
        {
          date,
          bytes: st.size,
          updatedAt: st.mtimeMs,
          preview: text.replace(/\s+/g, " ").slice(0, 140),
        },
      ];
    });
    res.json({
      index: deps.memory.indexText(),
      updatedAt: fileMtime(deps.memory.indexPath()),
      indexPath: deps.memory.indexPath(),
      diaries,
      now: Date.now(),
    });
  });

  app.get("/api/memory/diary", auth, (req, res) => {
    const date = typeof req.query.date === "string" ? req.query.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "date 需为 YYYY-MM-DD" });
      return;
    }
    const text = deps.memory.readDiary(date);
    if (text == null) {
      res.status(404).json({ error: "没有这一天的日记" });
      return;
    }
    res.json({ date, content: text });
  });

  // ---------- Token 用量统计 ----------

  app.get("/api/usage", auth, (req, res) => {
    const now = Date.now();
    const until = numberParam(req.query.until, now);
    const since = numberParam(req.query.since, until - 24 * HOUR);
    const span = until - since;
    if (!(until > since) || span < 60_000 || span > 400 * 24 * HOUR) {
      res.status(400).json({ error: "时间范围无效(需 1 分钟到 400 天)" });
      return;
    }
    const requestedRaw = req.query.bucket;
    const requested: "auto" | UsageBucketUnit =
      requestedRaw === "hour" || requestedRaw === "day" || requestedRaw === "week"
        ? requestedRaw
        : "auto";
    const rows = deps.repo.tokenUsageBetween(since, until);
    const previousRows = deps.repo.tokenUsageBetween(since - span, since);
    const agg = aggregateUsage(rows, since, until, requested, previousRows);
    const recent = deps.repo.recentTokenUsage(since, until, 50);
    res.json({
      since,
      until,
      now,
      ...agg,
      recent,
    });
  });

  // ---------- 插件面板与静态资源 ----------

  const MIME: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
  };

  const serveFrom = (
    baseDir: string | null,
    rel: string,
    res: express.Response,
  ): void => {
    if (!baseDir) {
      res.status(404).json({ error: "plugin has no such directory" });
      return;
    }
    const target = resolve(baseDir, rel);
    if (!isInside(baseDir, target) || !existsSync(target) || !statSync(target).isFile()) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.type(MIME[extname(target).toLowerCase()] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(readFileSync(target));
  };

  // 插件面板是「安装即信任」的本地代码,按静态资源提供(不含秘密);
  // 它调用的 API 仍然逐个鉴权。这样动态 import 不必把 token 放进 URL。
  app.get("/plugins/:id/panel/*", (req, res) => {
    const rel = (req.params as Record<string, string>)[0] ?? "";
    serveFrom(deps.plugins.panelDir((req.params.id ?? "")), rel, res);
  });

  app.get("/plugins/:id/assets/*", (req, res) => {
    const rel = (req.params as Record<string, string>)[0] ?? "";
    serveFrom(deps.plugins.assetDir((req.params.id ?? "")), rel, res);
  });

  // 前端静态资源:始终 revalidate,避免改了面板却被浏览器缓存住
  app.use(
    express.static(resolve("src/web/public"), {
      etag: true,
      lastModified: true,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
    }),
  );

  const server = app.listen(deps.port, deps.host ?? "127.0.0.1", () => {
    deps.log(`[panel] 管理面板 http://${deps.host ?? "127.0.0.1"}:${deps.port}/?token=***`);
  });
  return { stop: () => server.close() };
}
