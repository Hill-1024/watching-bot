import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readNapcatWebuiInfo,
  readNapcatWebuiToken,
  writeNapcatWebuiPort,
} from "../src/modules/napcat/webui-config.js";

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

  it("环境变量优先且文件缺失时安全返回 none", () => {
    const path = tempConfig("local-test-token");
    expect(
      readNapcatWebuiToken({
        NAPCAT_WEBUI_CONFIG: path,
        NAPCAT_WEBUI_TOKEN: "env-test-token",
      } as NodeJS.ProcessEnv),
    ).toEqual({ token: "env-test-token", source: "env" });

    expect(
      readNapcatWebuiToken({ NAPCAT_WEBUI_CONFIG: join(path, "missing", "webui.json") } as NodeJS.ProcessEnv),
    ).toEqual({ token: "", source: "none" });
  });

  it("读取端口并原子写回新端口,保留 token 与其他字段", () => {
    const path = tempConfig("local-test-token", 6099);
    const env = { NAPCAT_WEBUI_CONFIG: path } as NodeJS.ProcessEnv;

    expect(readNapcatWebuiInfo(env)).toMatchObject({
      token: "local-test-token",
      source: "webui-config",
      port: 6099,
      exists: true,
    });

    const updated = writeNapcatWebuiPort(6100, env);
    expect(updated).toMatchObject({
      token: "local-test-token",
      source: "webui-config",
      port: 6100,
      exists: true,
    });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({
      host: "127.0.0.1",
      token: "local-test-token",
      port: 6100,
    });
  });

  it("配置缺失时拒绝写入端口", () => {
    expect(() =>
      writeNapcatWebuiPort(6100, {
        NAPCAT_WEBUI_CONFIG: join(tmpdir(), "wb-napcat-webui-missing", "webui.json"),
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
