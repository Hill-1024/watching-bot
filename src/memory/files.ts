import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MemoryConfig } from "../config.js";

/**
 * 记忆文件层:MEMORY.md(长期事实 + 日记索引)+ memories/YYYY-MM-DD.md(日记)+ 周归并文件。
 * 日常上下文压缩由 pi 基座 compaction 负责;这里只服务「睡了仍该记得」的长期记忆。
 */
export class MemoryStore {
  constructor(private readonly cfg: MemoryConfig) {
    if (!existsSync(cfg.diaryDir)) mkdirSync(cfg.diaryDir, { recursive: true });
    if (!existsSync(resolve(cfg.memoryFile))) {
      writeFileSync(
        resolve(cfg.memoryFile),
        "# MEMORY.md — 长期记忆索引\n\n## 长期事实\n\n## 日记索引\n",
        "utf-8",
      );
    }
  }

  indexText(): string {
    try {
      return readFileSync(resolve(this.cfg.memoryFile), "utf-8");
    } catch {
      return "(记忆索引为空)";
    }
  }

  writeIndex(text: string): void {
    writeFileSync(resolve(this.cfg.memoryFile), text, "utf-8");
  }

  diaryPath(dateIso: string): string {
    return resolve(this.cfg.diaryDir, `${dateIso}.md`);
  }

  writeDiary(dateIso: string, content: string): void {
    writeFileSync(this.diaryPath(dateIso), content, "utf-8");
  }

  readDiary(dateIso: string): string | null {
    const p = this.diaryPath(dateIso);
    return existsSync(p) ? readFileSync(p, "utf-8") : null;
  }

  /** 最近 n 天(含今天)的日记 [{date, text}] */
  recentDiaries(n: number, todayIso: string): { date: string; text: string }[] {
    const out: { date: string; text: string }[] = [];
    const files = new Set(readdirSync(this.cfg.diaryDir));
    for (let i = 0; i < n; i++) {
      const d = new Date(todayIso);
      d.setDate(d.getDate() - i);
      const iso = d.toISOString().slice(0, 10);
      const f = `${iso}.md`;
      if (files.has(f)) {
        out.push({ date: iso, text: readFileSync(resolve(this.cfg.diaryDir, f), "utf-8") });
      }
    }
    return out;
  }

  /** 把若干日记合并为一个周文件,删除原日记;返回被合并的日期列表 */
  mergeDiariesToWeek(weekIso: string, dates: string[], content: string): string[] {
    writeFileSync(resolve(this.cfg.diaryDir, `${weekIso}.md`), content, "utf-8");
    for (const d of dates) {
      const p = this.diaryPath(d);
      if (existsSync(p)) rmSync(p);
    }
    return dates;
  }

  listDiaryDates(): string[] {
    return readdirSync(this.cfg.diaryDir)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort();
  }

  dir(): string {
    return resolve(this.cfg.diaryDir);
  }

  indexPath(): string {
    return resolve(this.cfg.memoryFile);
  }

  joinDiary(name: string): string {
    return join(this.cfg.diaryDir, name);
  }
}
