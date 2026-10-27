import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import start from "../plugins/builtin/server/index.js";
import { JsonPluginStorage } from "../src/plugins/storage.js";
import type { PluginContext } from "../src/plugins/types.js";

/**
 * 手工冒烟:不启动整个 bot,直接跑 builtin 插件的工具与动作。
 * 用法: npx tsx tools/drink-test.ts
 */
const dir = mkdtempSync(join(tmpdir(), "wb-drink-"));
const seen: unknown[] = [];
const ctx: PluginContext = {
  id: "builtin",
  manifest: { schemaVersion: 1, id: "builtin", name: "Builtin", version: "0", description: "", entry: "" },
  config: {
    overrideFile: join(dir, "builtin.json"),
    master: { qq: 123, name: "测试主人" },
    coffee: { dailyQuota: 2, refillSimHour: 0 },
  },
  dataDir: dir,
  simNow: () => Date.now(),
  realNow: () => Date.now(),
  logger: { debug: console.log, info: console.log, warn: console.warn, error: console.error },
  storage: new JsonPluginStorage(join(dir, "store.json")),
  emitPerception: (e) => seen.push(e),
};

const plugin = await start(ctx);
const tool = plugin.tools![0]!;
const call = () => tool.execute("t", {} as never) as Promise<{ content: unknown; details: unknown }>;

console.log("喝第1杯:", JSON.stringify((await call()).content));
await call();
console.log("感知(应含 stimulant):", JSON.stringify(seen));
console.log("第3杯(空):", JSON.stringify((await call()).content));

const state = await plugin.handle!({ method: "GET", path: "", query: {}, body: null });
console.log("状态:", JSON.stringify(state.body));
const granted = await plugin.handle!({ method: "POST", path: "grant", query: {}, body: { cups: 2 } });
console.log("补2杯后:", JSON.stringify(granted.body));
await plugin.stop();
process.exit(0);
