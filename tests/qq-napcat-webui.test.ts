import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readNapcatWebuiInfo,
  readNapcatWebuiToken,
  writeNapcatWebuiPort,
} from "../plugins/qq/server/napcat-webui.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(token?: string, port = 6099): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-napcat-webui-"));
  dirs.push(dir);
  const path = join(dir, "webui.json");
  writeFileSync(path, JSON.stringify({ host: "127.0.0.1", port, token }), "utf-8");
  return path;
}

describe("NapCat WebUI config", () => {
  it("从 NapCat webui.json 自动读取登录 token", () => {
    const path = tempConfig("local-test-token");
    expect(readNapcatWebuiToken({ NAPCAT_WEBUI_CONFIG: path } as NodeJS.ProcessEnv)).toEqual({
      token: "local-test-token",
      source: "webui-config",
    });
  });

  it("环境变量 NAPCAT_WEBUI_TOKEN 优先于文件", () => {
    const path = tempConfig("file-token");
    const info = readNapcatWebuiInfo({
      NAPCAT_WEBUI_CONFIG: path,
      NAPCAT_WEBUI_TOKEN: "env-token",
    } as NodeJS.ProcessEnv);
    expect(info.token).toBe("env-token");
    expect(info.source).toBe("env");
  });

  it("端口写回保留其它字段", () => {
    const path = tempConfig("t", 6099);
    const info = writeNapcatWebuiPort(6100, { NAPCAT_WEBUI_CONFIG: path } as NodeJS.ProcessEnv);
    expect(info.port).toBe(6100);
    const saved = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    expect(saved.host).toBe("127.0.0.1");
    expect(saved.token).toBe("t");
  });

  it("非法端口被拒绝", () => {
    const path = tempConfig("t", 6099);
    expect(() => writeNapcatWebuiPort(0, { NAPCAT_WEBUI_CONFIG: path } as NodeJS.ProcessEnv)).toThrow();
    expect(() => writeNapcatWebuiPort(70000, { NAPCAT_WEBUI_CONFIG: path } as NodeJS.ProcessEnv)).toThrow();
  });
});
