import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface NapcatWebuiTokenInfo {
  token: string;
  source: "webui-config" | "env" | "none";
}

export interface NapcatWebuiInfo extends NapcatWebuiTokenInfo {
  /** WebUI 端口;配置缺失或非法时为 0 */
  port: number;
  /** 是否找到并解析了 NapCat 的 webui.json */
  exists: boolean;
}

/** NapCat 本地安装的 WebUI 配置(当前项目的 runtime 布局) */
const DEFAULT_WEBUI_CONFIG = "runtime/napcat-node/napcat/config/webui.json";

function webuiConfigPath(env: NodeJS.ProcessEnv): string {
  return resolve((env.NAPCAT_WEBUI_CONFIG ?? "").trim() || DEFAULT_WEBUI_CONFIG);
}

function readRaw(env: NodeJS.ProcessEnv): {
  path: string;
  exists: boolean;
  data: Record<string, unknown> | null;
} {
  const path = webuiConfigPath(env);
  if (!existsSync(path)) return { path, exists: false, data: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
    return { path, exists: true, data };
  } catch {
    // 配置损坏/无权限等同于无内容,不把内容或路径写进日志
    return { path, exists: true, data: null };
  }
}

/** 读取 NapCat WebUI 配置(登录 token 与端口);每次调用都重新读盘 */
export function readNapcatWebuiInfo(env: NodeJS.ProcessEnv = process.env): NapcatWebuiInfo {
  const raw = readRaw(env);
  const fileToken = typeof raw.data?.token === "string" ? raw.data.token.trim() : "";
  const envToken = (env.NAPCAT_WEBUI_TOKEN ?? "").trim();
  const token = envToken || fileToken;
  const source: NapcatWebuiTokenInfo["source"] = envToken
    ? "env"
    : fileToken
      ? "webui-config"
      : "none";
  const portRaw = raw.data?.port;
  const port = typeof portRaw === "number" && Number.isInteger(portRaw) && portRaw > 0 && portRaw <= 65535
    ? portRaw
    : 0;
  return { token, source, port, exists: raw.exists };
}

/** 兼容旧调用:只取 token/source */
export function readNapcatWebuiToken(env: NodeJS.ProcessEnv = process.env): NapcatWebuiTokenInfo {
  const { token, source } = readNapcatWebuiInfo(env);
  return { token, source };
}

/**
 * 把新端口写回 NapCat 的 webui.json,保留 token/host 等全部字段。
 * 采用临时文件 + rename 原子替换,避免 NapCat 读到半截 JSON。
 */
export function writeNapcatWebuiPort(port: number, env: NodeJS.ProcessEnv = process.env): NapcatWebuiInfo {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("端口需为 1-65535 的整数");
  }
  const raw = readRaw(env);
  if (!raw.exists) {
    throw new Error(`未找到 NapCat WebUI 配置:${raw.path}`);
  }
  if (!raw.data) {
    throw new Error(`NapCat WebUI 配置无法解析:${raw.path}`);
  }
  const next = { ...raw.data, port };
  mkdirSync(dirname(raw.path), { recursive: true });
  const tmp = `${raw.path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf-8");
  renameSync(tmp, raw.path);
  return readNapcatWebuiInfo(env);
}
