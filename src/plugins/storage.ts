import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginStorage } from "./types.js";

/**
 * 插件私有 KV:一个插件一个 JSON 文件,原子写(tmp + rename)。
 *
 * 为什么够用:插件私有状态是小而稀疏的(咖啡余量、上次补给日、选中 runtime),
 * 不需要事务与并发写入。需要复杂查询的插件自己开 SQLite,路径由 dataDir 提供。
 * 核心永远不读这里的数据 —— 插件私有就是私有。
 */
export class JsonPluginStorage implements PluginStorage {
  private data: Record<string, unknown>;

  constructor(
    private readonly filePath: string,
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.data = readJson(filePath, log);
  }

  get<T>(key: string, fallback: T): T {
    return (this.data[key] as T | undefined) ?? fallback;
  }

  set<T>(key: string, value: T): void {
    this.data[key] = value;
    this.flush();
  }

  delete(key: string): void {
    if (!(key in this.data)) return;
    delete this.data[key];
    this.flush();
  }

  all(): Record<string, unknown> {
    return { ...this.data };
  }

  private flush(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.log(`插件存储写入失败(${this.filePath}): ${String(err)}`);
      throw err;
    }
  }
}

export function pluginStoragePath(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins", `${pluginId}.json`);
}

function readJson(path: string, log: (msg: string) => void): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    log(`插件存储解析失败(${path}),按空状态继续: ${String(err)}`);
    return {};
  }
}
