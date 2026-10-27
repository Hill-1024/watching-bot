import Database from "better-sqlite3";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface DbHandles {
  db: Database.Database;
  path: string;
}

/** 一次模型调用的 token 记录(面板 Token 统计页的数据源) */
export interface TokenUsageRow {
  tsReal: number;
  tsSim: number;
  /** main | compaction | memory | weekly | judge */
  source: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  total: number;
  costTotal: number;
}

export interface ActivityRow {
  id: number;
  tsSim: number;
  tsReal: number;
  kind: string;
  text: string;
}

export interface InjectionRow {
  id: number;
  ts_sim: number;
  channel: string;
  kind: string;
  tier: number | null;
  text: string;
}

export function openDb(dataDir: string): DbHandles {
  const dir = resolve(dataDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "watching-bot.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_sim INTEGER NOT NULL,
      phase TEXT NOT NULL,
      vars TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_state_history_ts ON state_history(ts_sim);
    CREATE TABLE IF NOT EXISTS injections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_sim INTEGER NOT NULL,
      channel TEXT NOT NULL,            -- 'feeling' | 'env'
      kind TEXT NOT NULL,
      tier INTEGER,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sleep_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      start_sim INTEGER NOT NULL,
      end_sim INTEGER,
      start_reason TEXT NOT NULL,
      end_reason TEXT,
      snooze_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS alarms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      due_sim INTEGER NOT NULL,
      created_sim INTEGER NOT NULL,
      origin TEXT NOT NULL,             -- 'agent' | 'panel'
      note TEXT,
      status TEXT NOT NULL DEFAULT 'pending'  -- 'pending' | 'rang' | 'cancelled'
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_sim INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT
    );
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_real INTEGER NOT NULL,
      ts_sim INTEGER NOT NULL,
      source TEXT NOT NULL,             -- 'main' | 'compaction' | 'memory' | 'weekly' | 'judge'
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      input INTEGER NOT NULL DEFAULT 0,
      output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      reasoning INTEGER NOT NULL DEFAULT 0,
      total INTEGER NOT NULL DEFAULT 0,
      cost_total REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage(ts_real);
    CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source);
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_sim INTEGER NOT NULL,
      ts_real INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activity_log_ts ON activity_log(ts_real);
    CREATE INDEX IF NOT EXISTS idx_activity_log_kind ON activity_log(kind);
  `);
  return { db, path };
}

/** 行仓储:轻封装,全部同步(better-sqlite3) */
export class Repo {
  constructor(private readonly h: DbHandles) {}

  insertStateHistory(tsSim: number, phase: string, vars: unknown): void {
    this.h.db
      .prepare("INSERT INTO state_history(ts_sim, phase, vars) VALUES (?,?,?)")
      .run(tsSim, phase, JSON.stringify(vars));
  }

  /** 状态历史区间采样:按 id 固定步长抽稀,避免高 timeScale 下一次拉几十万行 */
  stateHistoryRange(
    sinceSim: number,
    untilSim: number,
    maxPoints: number,
  ): { ts_sim: number; phase: string; vars: string }[] {
    const countRow = this.h.db
      .prepare("SELECT COUNT(*) AS n FROM state_history WHERE ts_sim>=? AND ts_sim<?")
      .get(sinceSim, untilSim) as { n: number };
    const total = countRow.n;
    if (total === 0) return [];
    const stride = Math.max(1, Math.ceil(total / Math.max(1, maxPoints)));
    return this.h.db
      .prepare(
        `SELECT ts_sim, phase, vars FROM state_history
         WHERE ts_sim>=? AND ts_sim<? AND (id % ? = 0)
         ORDER BY ts_sim ASC`,
      )
      .all(sinceSim, untilSim, stride) as { ts_sim: number; phase: string; vars: string }[];
  }

  insertInjection(tsSim: number, channel: string, kind: string, tier: number | null, text: string): void {
    this.h.db
      .prepare("INSERT INTO injections(ts_sim, channel, kind, tier, text) VALUES (?,?,?,?,?)")
      .run(tsSim, channel, kind, tier, text);
  }

  insertEvent(tsSim: number, type: string, payload?: unknown): void {
    this.h.db
      .prepare("INSERT INTO events(ts_sim, type, payload) VALUES (?,?,?)")
      .run(tsSim, type, payload == null ? null : JSON.stringify(payload));
  }

  insertSleepLog(startSim: number, startReason: string): number {
    const info = this.h.db
      .prepare("INSERT INTO sleep_log(start_sim, start_reason) VALUES (?,?)")
      .run(startSim, startReason);
    return Number(info.lastInsertRowid);
  }

  closeSleepLog(id: number, endSim: number, endReason: string, snoozeCount: number): void {
    this.h.db
      .prepare("UPDATE sleep_log SET end_sim=?, end_reason=?, snooze_count=? WHERE id=?")
      .run(endSim, endReason, snoozeCount, id);
  }

  addAlarm(dueSim: number, createdSim: number, origin: string, note?: string): number {
    const info = this.h.db
      .prepare("INSERT INTO alarms(due_sim, created_sim, origin, note) VALUES (?,?,?,?)")
      .run(dueSim, createdSim, origin, note ?? null);
    return Number(info.lastInsertRowid);
  }

  duePendingAlarms(nowSim: number): { id: number; due_sim: number; note: string | null }[] {
    return this.h.db
      .prepare("SELECT id, due_sim, note FROM alarms WHERE status='pending' AND due_sim<=? ORDER BY due_sim")
      .all(nowSim) as { id: number; due_sim: number; note: string | null }[];
  }

  markAlarm(id: number, status: "rang" | "cancelled"): void {
    this.h.db.prepare("UPDATE alarms SET status=? WHERE id=?").run(status, id);
  }

  pendingAlarmCount(): number {
    const row = this.h.db.prepare("SELECT COUNT(*) AS n FROM alarms WHERE status='pending'").get() as { n: number };
    return row.n;
  }

  // ---------- 注入流水 ----------

  recentInjections(limit: number): InjectionRow[] {
    return this.h.db
      .prepare("SELECT * FROM injections ORDER BY id DESC LIMIT ?")
      .all(limit) as InjectionRow[];
  }

  /** 增量拉取:比 afterId 新的条目(升序),供面板实时追加而不重建列表 */
  injectionsAfter(afterId: number, limit: number): InjectionRow[] {
    return this.h.db
      .prepare("SELECT * FROM injections WHERE id>? ORDER BY id ASC LIMIT ?")
      .all(afterId, limit) as InjectionRow[];
  }

  injectionPage(opts: { page: number; pageSize: number; channel?: string }): {
    items: InjectionRow[];
    total: number;
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.channel === "feeling" || opts.channel === "env") {
      where.push("channel=?");
      params.push(opts.channel);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRow = this.h.db
      .prepare(`SELECT COUNT(*) AS n FROM injections ${whereSql}`)
      .get(...params) as { n: number };
    const offset = (opts.page - 1) * opts.pageSize;
    const items = this.h.db
      .prepare(`SELECT * FROM injections ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.pageSize, offset) as InjectionRow[];
    return { items, total: countRow.n };
  }

  stateHistorySince(tsSim: number, limit: number): unknown[] {
    return this.h.db
      .prepare("SELECT * FROM state_history WHERE ts_sim>=? ORDER BY id ASC LIMIT ?")
      .all(tsSim, limit);
  }

  // ---------- 活动日志(持久化 + 分页) ----------

  insertActivity(tsSim: number, tsReal: number, kind: string, text: string): void {
    this.h.db
      .prepare("INSERT INTO activity_log(ts_sim, ts_real, kind, text) VALUES (?,?,?,?)")
      .run(tsSim, tsReal, kind, text);
  }

  activityPage(opts: {
    page: number;
    pageSize: number;
    kinds?: string[];
    query?: string;
  }): { items: ActivityRow[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kinds && opts.kinds.length > 0) {
      where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    const q = opts.query?.trim();
    if (q) {
      where.push("text LIKE ?");
      params.push(`%${q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRow = this.h.db
      .prepare(`SELECT COUNT(*) AS n FROM activity_log ${whereSql}`)
      .get(...params) as { n: number };
    const offset = (opts.page - 1) * opts.pageSize;
    const rows = this.h.db
      .prepare(`SELECT id, ts_sim, ts_real, kind, text FROM activity_log ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, opts.pageSize, offset) as {
      id: number;
      ts_sim: number;
      ts_real: number;
      kind: string;
      text: string;
    }[];
    const items = rows.map((r) => ({
      id: r.id,
      tsSim: r.ts_sim,
      tsReal: r.ts_real,
      kind: r.kind,
      text: r.text,
    }));
    return { items, total: countRow.n };
  }

  /** 只保留最近 keep 条,避免长期挂机把日志表撑爆 */
  pruneActivityLog(keep = 20_000): void {
    this.pruneByCount("activity_log", keep);
  }

  /**
   * 面板历史表的保留策略。按条数而不是按天:模拟时间可以飞,真实天数没有稳定含义。
   * 单条 DELETE 带上限,避免一次清掉几十万行走满事务。
   */
  pruneHistory(limits: { state?: number; injections?: number; usage?: number; activity?: number } = {}): {
    state: number;
    injections: number;
    usage: number;
    activity: number;
  } {
    return {
      state: this.pruneByCount("state_history", limits.state ?? 50_000),
      injections: this.pruneByCount("injections", limits.injections ?? 20_000),
      usage: this.pruneByCount("token_usage", limits.usage ?? 50_000),
      activity: this.pruneByCount("activity_log", limits.activity ?? 20_000),
    };
  }

  private pruneByCount(table: string, keep: number): number {
    if (!Number.isInteger(keep) || keep < 1) return 0;
    const info = this.h.db
      .prepare(
        `DELETE FROM ${table} WHERE id <= COALESCE(
           (SELECT id FROM ${table} ORDER BY id DESC LIMIT 1 OFFSET ?), 0
         )`,
      )
      .run(keep);
    return info.changes;
  }

  /** 库文件字节数,面板用来看保留策略有没有生效 */
  fileBytes(): number {
    try {
      return statSync(this.h.path).size;
    } catch {
      return 0;
    }
  }

  // ---------- Token 用量 ----------

  insertTokenUsage(row: TokenUsageRow): void {
    this.h.db
      .prepare(
        `INSERT INTO token_usage(
           ts_real, ts_sim, source, provider, model, input, output,
           cache_read, cache_write, reasoning, total, cost_total
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.tsReal,
        row.tsSim,
        row.source,
        row.provider,
        row.model,
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
        row.reasoning,
        row.total,
        row.costTotal,
      );
  }

  tokenUsageBetween(sinceReal: number, untilReal: number): TokenUsageRow[] {
    const rows = this.h.db
      .prepare("SELECT * FROM token_usage WHERE ts_real>=? AND ts_real<? ORDER BY ts_real ASC")
      .all(sinceReal, untilReal) as {
      ts_real: number;
      ts_sim: number;
      source: string;
      provider: string;
      model: string;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      reasoning: number;
      total: number;
      cost_total: number;
    }[];
    return rows.map((r) => ({
      tsReal: r.ts_real,
      tsSim: r.ts_sim,
      source: r.source,
      provider: r.provider,
      model: r.model,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      reasoning: r.reasoning,
      total: r.total,
      costTotal: r.cost_total,
    }));
  }

  /** 最近请求明细(倒序),统计页表格用 */
  recentTokenUsage(sinceReal: number, untilReal: number, limit: number): TokenUsageRow[] {
    const rows = this.h.db
      .prepare("SELECT * FROM token_usage WHERE ts_real>=? AND ts_real<? ORDER BY ts_real DESC LIMIT ?")
      .all(sinceReal, untilReal, limit) as {
      ts_real: number;
      ts_sim: number;
      source: string;
      provider: string;
      model: string;
      input: number;
      output: number;
      cache_read: number;
      cache_write: number;
      reasoning: number;
      total: number;
      cost_total: number;
    }[];
    return rows.map((r) => ({
      tsReal: r.ts_real,
      tsSim: r.ts_sim,
      source: r.source,
      provider: r.provider,
      model: r.model,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      reasoning: r.reasoning,
      total: r.total,
      costTotal: r.cost_total,
    }));
  }

  close(): void {
    this.h.db.close();
  }
}
