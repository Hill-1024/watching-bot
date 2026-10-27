import { ConfigError } from "../config-schema.js";
import type { RuntimeId } from "../plugins/types.js";

/**
 * 固定的 runtime 注册表。
 *
 * 安全模型的关键:镜像、容器名、卷、端口、安全选项全部来自代码里的白名单,
 * 用户/插件只能改「宿主端口」这一类的受限字段。任何 image/cmd/bind mount 输入都会被拒绝,
 * 否则 supervisor 就等于把 Docker socket 直接交给了调用方。
 */

export interface RuntimeSettings {
  /** 宿主端口覆盖(仅 loopback) */
  hostPorts?: { webui?: number; novnc?: number };
  /** 受限环境变量(每个 runtime 有白名单) */
  env?: Record<string, string>;
  /** QQ 号(可选,写入 runtime 环境变量) */
  selfId?: number;
}

export interface PortBinding {
  containerPort: number;
  hostPort: number;
  hostIp: string;
}

export interface VolumeBinding {
  /** 命名卷(不允许 bind mount 宿主路径) */
  volume: string;
  containerPath: string;
}

export interface Ulimit {
  name: string;
  soft: number;
  hard: number;
}

export interface ContainerSpec {
  runtime: RuntimeId;
  name: string;
  image: string;
  env: Record<string, string>;
  volumes: VolumeBinding[];
  ports: PortBinding[];
  labels: Record<string, string>;
  aliases: string[];
  shmSizeBytes?: number;
  capAdd: string[];
  securityOpt: string[];
  ulimits: Ulimit[];
  restartPolicy: string;
}

export interface RuntimeDefinition {
  id: RuntimeId;
  displayName: string;
  image: string;
  containerName: string;
  aliases: string[];
  volumes: VolumeBinding[];
  ports: { kind: "webui" | "novnc"; containerPort: number; defaultHostPort: number }[];
  allowedEnvKeys: string[];
  build(spec: RuntimeSettings): Omit<ContainerSpec, "runtime" | "name" | "image" | "labels" | "aliases">;
}

const GB = 1024 * 1024 * 1024;

export const RUNTIME_DEFINITIONS: Record<RuntimeId, RuntimeDefinition> = {
  napcat: {
    id: "napcat",
    displayName: "NapCat",
    image: "mlikiowa/napcat-docker:latest",
    containerName: "watching-qq-napcat",
    aliases: ["napcat"],
    volumes: [
      { volume: "watching-qq-napcat-config", containerPath: "/app/napcat/config" },
      { volume: "watching-qq-napcat-qq", containerPath: "/app/.config/QQ" },
    ],
    ports: [{ kind: "webui", containerPort: 6099, defaultHostPort: 6099 }],
    allowedEnvKeys: ["NAPCAT_TOKEN", "NAPCAT_WEBUI_TOKEN", "QQ_ACCOUNT"],
    build: (settings) => ({
      env: sanitizeEnv("napcat", settings.env),
      volumes: RUNTIME_DEFINITIONS.napcat.volumes,
      ports: [
        {
          containerPort: 6099,
          hostPort: portOf(settings.hostPorts?.webui, 6099, "napcat.webui"),
          hostIp: "127.0.0.1",
        },
      ],
      shmSizeBytes: 256 * 1024 * 1024,
      capAdd: [],
      securityOpt: [],
      ulimits: [],
      restartPolicy: "unless-stopped",
    }),
  },
  snowluma: {
    id: "snowluma",
    displayName: "SnowLuma",
    image: "motricseven7/snowluma:latest",
    containerName: "watching-qq-snowluma",
    aliases: ["snowluma"],
    volumes: [
      { volume: "watching-qq-snowluma-data", containerPath: "/app/data" },
      { volume: "watching-qq-snowluma-config", containerPath: "/app/.config" },
      { volume: "watching-qq-snowluma-local", containerPath: "/app/.local/share" },
    ],
    ports: [
      { kind: "webui", containerPort: 5099, defaultHostPort: 5099 },
      { kind: "novnc", containerPort: 6081, defaultHostPort: 6081 },
    ],
    allowedEnvKeys: ["SNOWLUMA_TOKEN", "QQ_ACCOUNT"],
    build: (settings) => ({
      env: sanitizeEnv("snowluma", settings.env),
      volumes: RUNTIME_DEFINITIONS.snowluma.volumes,
      ports: [
        {
          containerPort: 5099,
          hostPort: portOf(settings.hostPorts?.webui, 5099, "snowluma.webui"),
          hostIp: "127.0.0.1",
        },
        {
          containerPort: 6081,
          hostPort: portOf(settings.hostPorts?.novnc, 6081, "snowluma.novnc"),
          hostIp: "127.0.0.1",
        },
      ],
      shmSizeBytes: GB,
      // 官方部署要求:noVNC/Chromium 需要 ptrace 与放宽 seccomp
      capAdd: ["SYS_PTRACE"],
      securityOpt: ["seccomp=unconfined"],
      ulimits: [{ name: "nofile", soft: 65536, hard: 65536 }],
      restartPolicy: "unless-stopped",
    }),
  },
};

export function runtimeIds(): RuntimeId[] {
  return Object.keys(RUNTIME_DEFINITIONS) as RuntimeId[];
}

export function isRuntimeId(v: unknown): v is RuntimeId {
  return v === "napcat" || v === "snowluma";
}

export function buildContainerSpec(id: RuntimeId, settings: RuntimeSettings = {}): ContainerSpec {
  const def = RUNTIME_DEFINITIONS[id];
  const parts = def.build(settings);
  const ports = [...parts.ports];
  const seen = new Set<number>();
  for (const p of ports) {
    if (seen.has(p.hostPort)) {
      throw new ConfigError(`${id}: 宿主端口 ${p.hostPort} 在同一 runtime 内重复`, [`hostPorts: ${p.hostPort}`]);
    }
    seen.add(p.hostPort);
  }
  return {
    ...parts,
    runtime: id,
    name: def.containerName,
    image: def.image,
    labels: { "watching-bot.runtime": id, "watching-bot.managed": "true" },
    aliases: def.aliases,
  };
}

function portOf(raw: number | undefined, fallback: number, field: string): number {
  if (raw === undefined) return fallback;
  if (!Number.isInteger(raw) || raw < 1 || raw > 65535) {
    throw new ConfigError(`${field}: 端口必须是 1-65535 的整数`, [field]);
  }
  return raw;
}

function sanitizeEnv(id: RuntimeId, raw: Record<string, string> | undefined): Record<string, string> {
  const allowed = new Set(RUNTIME_DEFINITIONS[id].allowedEnvKeys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (!allowed.has(k)) throw new ConfigError(`${id}: 不允许的环境变量 ${k}`, [`env.${k}`]);
    if (typeof v !== "string" || v.length > 512 || /[\n\r]/.test(v)) {
      throw new ConfigError(`${id}: 环境变量 ${k} 取值非法`, [`env.${k}`]);
    }
    out[k] = v;
  }
  return out;
}

export const SUPERVISOR_NETWORK = "watching-bot-qqnet";
