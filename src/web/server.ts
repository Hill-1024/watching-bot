import express from "express";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ModuleBus } from "../bus/types.js";
import type { SimClock } from "../core/clock.js";
import { fmtSim } from "../core/clock.js";
import type { AgentCore } from "../core/loop.js";
import type { Repo } from "../store/db.js";

export interface PanelDeps {
  clock: SimClock;
  core: AgentCore;
  bus: ModuleBus;
  repo: Repo;
  /** 模块热插拔 */
  setModule(name: string, enable: boolean): Promise<{ ok: boolean; error?: string }>;
  port: number;
  token: string;
  log(msg: string): void;
}

/**
 * Web 管理面板(读写):
 * - 看:实时状态、历史曲线、注入流水、事件流水
 * - 管:直接改五维状态值、手动触发睡眠归并、强制醒/睡、热调 timeScale、模块启停
 * 全部经由核心命令 API,与状态管理器同级,不破坏 modules → bus ← core ← manager 依赖方向。
 */
export function startPanel(deps: PanelDeps): { stop(): void } {
  const app = express();
  app.use(express.json());

  const auth = (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!deps.token) return next();
    const header = req.headers.authorization ?? "";
    const q = typeof req.query.token === "string" ? req.query.token : "";
    if (header === `Bearer ${deps.token}` || q === deps.token) return next();
    res.status(401).json({ error: "unauthorized" });
  };

  app.get("/api/status", auth, (_req, res) => {
    const snap = deps.core.snapshotNow();
    res.json({
      sim: fmtSim(deps.clock.simNow()),
      simMs: deps.clock.simNow(),
      timeScale: deps.clock.timeScale,
      phase: deps.core.machine.phase,
      sleepStartedSim: deps.core.machine.sleepStartedSim,
      snoozeCount: deps.core.machine.snoozeCount,
      vars: snap.vars,
      modules: deps.bus.status(),
    });
  });

  app.get("/api/history", auth, (req, res) => {
    const since = Number(req.query.since ?? 0) || 0;
    res.json(deps.repo.stateHistorySince(since, 600));
  });

  app.get("/api/injections", auth, (_req, res) => {
    res.json(deps.repo.recentInjections(80));
  });

  app.post("/api/vars", auth, (req, res) => {
    const { name, value } = req.body as { name?: string; value?: number };
    if (typeof name !== "string" || typeof value !== "number" || !Number.isFinite(value)) {
      res.status(400).json({ error: "需要 { name, value }" });
      return;
    }
    const snap = deps.core.applyState({ type: "setVar", name, value });
    deps.log(`[panel] 状态调整 ${name} = ${value}`);
    res.json({ ok: true, vars: snap.vars });
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
    if (typeof value !== "number" || !(value > 0) || value > 100000) {
      res.status(400).json({ error: "value 需为正数" });
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

  app.use(express.static(resolve("src/web/public")));

  const server = app.listen(deps.port, () => {
    deps.log(`[panel] 管理面板 http://127.0.0.1:${deps.port}/?token=***`);
  });
  return { stop: () => server.close() };
}
