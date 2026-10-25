import express from "express";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ModuleBus } from "../bus/types.js";
import type { SimClock } from "../core/clock.js";
import { HOUR, fmtSim } from "../core/clock.js";
import type { AgentCore } from "../core/loop.js";
import type { ModelManager, ModelOverride } from "../core/model-manager.js";
import { aggregateUsage, type UsageBucketUnit } from "../core/usage.js";
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

export interface PanelDeps {
  clock: SimClock;
  core: AgentCore;
  bus: ModuleBus;
  repo: Repo;
  modelManager: ModelManager;
  memory: PanelMemory;
  /** 状态变量上下限(面板钳制与渲染用) */
  varDefs: Record<string, VarDef>;
  /** 已注册的模块工厂名(热插拔展示用) */
  knownModules: string[];
  /** 进程启动时间(真实 ms) */
  startedAt: number;
  /** 面板切换模型后,把新句柄热替换到 pi Agent(在 index.ts 闭包里做) */
  onModelChanged(): void;
  /** builtin 模块的咖啡配给(模块未启用时为 null) */
  coffee: { remaining(): number; grant(n: number): void } | null;
  /** 模块热插拔 */
  setModule(name: string, enable: boolean): Promise<{ ok: boolean; error?: string }>;
  port: number;
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
  app.use(express.json({ limit: "256kb" }));

  const auth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!deps.token) return next();
    const header = req.headers.authorization ?? "";
    const q = typeof req.query.token === "string" ? req.query.token : "";
    if (header === `Bearer ${deps.token}` || q === deps.token) return next();
    res.status(401).json({ error: "unauthorized" });
  };

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
      modules: deps.bus.status(),
      knownModules: deps.knownModules,
      activityLastSeq: deps.core.activityLastSeq(),
      memoryUpdatedAt: fileMtime(deps.memory.indexPath()),
      panel: { port: deps.port, authRequired: Boolean(deps.token) },
    });
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
    deps.log(`[panel] 状态调整 ${name} = ${clamped}`);
    res.json({ ok: true, vars: snap.vars, applied: snap.vars[name], clamped: clamped !== value });
  });

  app.post("/api/consolidate", auth, async (_req, res) => {
    deps.log("[panel] 手动触发睡眠归并");
    try {
      await deps.core.runConsolidation();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post("/api/sleep", auth, (_req, res) => {
    deps.core.requestSleep("panel");
    res.json({ ok: true });
  });

  app.post("/api/wake", auth, (_req, res) => {
    deps.core.forceWake("panel");
    res.json({ ok: true });
  });

  app.post("/api/timescale", auth, (req, res) => {
    const { value } = req.body as { value?: number };
    if (typeof value !== "number" || !(value > 0) || value > 100_000) {
      res.status(400).json({ error: "value 需为正数且不超过 100000" });
      return;
    }
    deps.clock.setTimeScale(value);
    deps.log(`[panel] timeScale → ${value}`);
    res.json({ ok: true, timeScale: value });
  });

  app.post("/api/modules", auth, async (req, res) => {
    const { name, enable } = req.body as { name?: string; enable?: boolean };
    if (typeof name !== "string" || typeof enable !== "boolean") {
      res.status(400).json({ error: "需要 { name, enable }" });
      return;
    }
    try {
      const r = await deps.setModule(name, enable);
      if (!r.ok) {
        res.status(400).json(r);
        return;
      }
      deps.core.refreshAgentTools();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
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
    res.json({ ok: true, model: deps.modelManager.view() });
  });

  /** 咖啡配给(builtin 模块) */
  app.get("/api/coffee", auth, (_req, res) => {
    if (!deps.coffee) {
      res.status(404).json({ error: "builtin 模块未启用" });
      return;
    }
    res.json({ remaining: deps.coffee.remaining() });
  });

  app.post("/api/coffee", auth, (req, res) => {
    if (!deps.coffee) {
      res.status(404).json({ error: "builtin 模块未启用" });
      return;
    }
    const n = Math.max(0, Math.min(20, Math.round(numberParam((req.body as { n?: number }).n, 1))));
    deps.coffee.grant(n);
    deps.log(`[panel] 主人补了 ${n} 杯咖啡,现存 ${deps.coffee.remaining()}`);
    res.json({ ok: true, remaining: deps.coffee.remaining() });
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

  // 前端静态资源:始终 revalidate,避免改了面板却被浏览器缓存住
  app.use(
    express.static(resolve("src/web/public"), {
      etag: true,
      lastModified: true,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
    }),
  );

  const server = app.listen(deps.port, () => {
    deps.log(`[panel] 管理面板 http://127.0.0.1:${deps.port}/?token=***`);
  });
  return { stop: () => server.close() };
}
