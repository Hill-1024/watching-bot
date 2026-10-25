import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const QQ_BACKENDS = ["napcat", "snowluma"] as const;
export type QqBackend = (typeof QQ_BACKENDS)[number];
export const DEFAULT_QQ_BACKEND: QqBackend = "napcat";
export const QQ_BACKEND_FILE = "data/qq-backend.json";

export function isQqBackend(value: unknown): value is QqBackend {
  return value === "napcat" || value === "snowluma";
}

/** 读取用户选择的 QQ 接入运行时;缺失/损坏时默认 NapCat。 */
export function loadQqBackend(path = QQ_BACKEND_FILE): QqBackend {
  const p = resolve(path);
  if (!existsSync(p)) return DEFAULT_QQ_BACKEND;
  try {
    const data = JSON.parse(readFileSync(p, "utf-8")) as { backend?: unknown };
    return isQqBackend(data.backend) ? data.backend : DEFAULT_QQ_BACKEND;
  } catch {
    return DEFAULT_QQ_BACKEND;
  }
}

/** 原子保存选择;文件位于 gitignored 的 data/。 */
export function saveQqBackend(backend: QqBackend, path = QQ_BACKEND_FILE): void {
  if (!isQqBackend(backend)) throw new Error(`未知 QQ 后端: ${String(backend)}`);
  const p = resolve(path);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify({ backend }, null, 2), "utf-8");
  renameSync(tmp, p);
}
