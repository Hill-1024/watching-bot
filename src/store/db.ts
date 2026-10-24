import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface DbHandles {
  db: Database.Database;
  path: string;
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

  recentInjections(limit: number): unknown[] {
    return this.h.db
      .prepare("SELECT * FROM injections ORDER BY id DESC LIMIT ?")
      .all(limit);
  }

  stateHistorySince(tsSim: number, limit: number): unknown[] {
    return this.h.db
      .prepare("SELECT * FROM state_history WHERE ts_sim>=? ORDER BY id ASC LIMIT ?")
      .all(tsSim, limit);
  }

  close(): void {
    this.h.db.close();
  }
}
