import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleCtx } from "../src/bus/types.js";
import { BuiltinModule } from "../src/modules/builtin/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempOverridePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-builtin-"));
  dirs.push(dir);
  return join(dir, "builtin.json");
}

describe("builtin runtime config", () => {
  it("面板可更新称呼/QQ/配额并持久化到覆盖层", async () => {
    const overrideFile = tempOverridePath();
    const mod = new BuiltinModule();
    const ctx: ModuleCtx = {
      config: {
        overrideFile,
        master: { qq: 10001, name: "阿岚" },
        coffee: { dailyQuota: 3, refillSimHour: 8 },
      },
      emitPerception: () => {},
      simNow: () => Date.UTC(2026, 9, 25, 12, 0, 0),
      log: () => {},
    };
    await mod.init(ctx);

    expect(mod.configView()).toEqual({
      master: { qq: 10001, name: "阿岚" },
      coffee: { dailyQuota: 3, refillSimHour: 8 },
    });
    expect(mod.tools[0]?.description ?? "").toContain("阿岚");

    mod.updateConfig({
      master: { qq: 10002, name: "小满" },
      coffee: { dailyQuota: 5 },
    });

    expect(mod.configView().master).toEqual({ qq: 10002, name: "小满" });
    expect(mod.configView().coffee.dailyQuota).toBe(5);
    expect(mod.tools[0]?.description ?? "").toContain("小满");

    const persisted = JSON.parse(readFileSync(overrideFile, "utf-8")) as {
      master: { qq: number; name: string };
      coffee: { dailyQuota: number; refillSimHour: number };
    };
    expect(persisted.master).toEqual({ qq: 10002, name: "小满" });
    expect(persisted.coffee.dailyQuota).toBe(5);
    expect(persisted.coffee.refillSimHour).toBe(8);
  });

  it("非法配额被钳制,空称呼不会覆盖已有称呼", async () => {
    const overrideFile = tempOverridePath();
    const mod = new BuiltinModule();
    await mod.init({
      config: {
        overrideFile,
        master: { qq: 10001, name: "阿岚" },
        coffee: { dailyQuota: 3, refillSimHour: 8 },
      },
      emitPerception: () => {},
      simNow: () => Date.UTC(2026, 9, 25, 12, 0, 0),
      log: () => {},
    });

    mod.updateConfig({ master: { name: "   " }, coffee: { dailyQuota: 99 } });
    expect(mod.configView().master.name).toBe("阿岚");
    expect(mod.configView().coffee.dailyQuota).toBe(50);
  });
});
