import express from "express";
import { timingSafeEqual } from "node:crypto";
import { ConfigError } from "../config-schema.js";
import { RUNTIME_DEFINITIONS, isRuntimeId, runtimeIds, type RuntimeSettings } from "./registry.js";
import type { RuntimeSupervisor } from "./supervisor.js";

export interface SupervisorServerDeps {
  supervisor: RuntimeSupervisor;
  port: number;
  token: string;
  log(msg: string): void;
}

/**
 * Supervisor 的唯一对外接口(仅内部网络)。
 *
 * 它就是「受控的 Docker 代理」:调用方只能按 runtime ID 做 install/start/stop/restart,
 * 不能传镜像、命令、宿主路径或任意 bind mount。所有写操作要求 Bearer token,
 * token 为空时拒绝启动 —— 宁可不启动,也不要把 Docker socket 裸奔。
 */
export function startSupervisorServer(deps: SupervisorServerDeps): { stop(): void; port(): number } {
  if (!deps.token) {
    throw new Error("WATCHING_BOT_SUPERVISOR_TOKEN 未配置:拒绝启动 supervisor(它等价于 Docker 高权限)");
  }
  const expected = Buffer.from(deps.token);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  app.use((req, res, next) => {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (given.length === expected.length && timingSafeEqual(given, expected)) {
      res.setHeader("Cache-Control", "no-store");
      return next();
    }
    res.status(401).json({ error: "unauthorized" });
  });

  const runtimeOf = (raw: string): string => {
    if (!isRuntimeId(raw)) throw new ConfigError("runtime 必须是 napcat 或 snowluma", ["runtime"]);
    return raw;
  };

  const settingsOf = (body: unknown): RuntimeSettings => parseSettings(body);

  app.get("/v1/healthz", (_req, res) => {
    res.json({ ok: true, runtimes: runtimeIds() });
  });

  app.get("/v1/runtimes", async (_req, res) => {
    try {
      res.json({ runtimes: await deps.supervisor.list() });
    } catch (err) {
      res.status(500).json({ error: messageOf(err) });
    }
  });

  app.get("/v1/runtimes/:id", async (req, res) => {
    try {
      const id = runtimeOf(req.params.id);
      res.json(await deps.supervisor.inspect(id as never));
    } catch (err) {
      respondError(res, err);
    }
  });

  for (const action of ["install", "start", "stop", "restart", "recreate"] as const) {
    app.post(`/v1/runtimes/:id/${action}`, async (req, res) => {
      try {
        const id = runtimeOf(req.params.id) as keyof typeof RUNTIME_DEFINITIONS;
        const settings = action === "stop" ? {} : settingsOf(req.body);
        await assertNoPortConflict(deps.supervisor, id, settings);
        deps.log(`[supervisor] ${action} ${id}`);
        const result =
          action === "stop"
            ? await deps.supervisor.stop(id)
            : action === "start"
              ? await deps.supervisor.start(id, settings)
              : action === "restart"
                ? await deps.supervisor.restart(id, settings)
                : action === "install"
                  ? await deps.supervisor.install(id, settings)
                  : await deps.supervisor.recreate(id, settings);
        res.json(result);
      } catch (err) {
        respondError(res, err);
      }
    });
  }

  app.get("/v1/runtimes/:id/logs", async (req, res) => {
    try {
      const id = runtimeOf(req.params.id) as keyof typeof RUNTIME_DEFINITIONS;
      const tail = Number(req.query.tail ?? 200);
      const logs = await deps.supervisor.logs(id, Number.isFinite(tail) ? tail : 200);
      res.json({ runtime: id, logs });
    } catch (err) {
      respondError(res, err);
    }
  });

  app.get("/v1/runtimes/:id/files/:key", async (req, res) => {
    try {
      const id = runtimeOf(req.params.id) as keyof typeof RUNTIME_DEFINITIONS;
      const content = await deps.supervisor.readFile(id, String(req.params.key ?? ""));
      res.json({ runtime: id, key: req.params.key, content });
    } catch (err) {
      respondError(res, err);
    }
  });

  app.get("/v1/operations/:operationId", (req, res) => {
    const op = deps.supervisor.operation(req.params.operationId);
    if (!op) {
      res.status(404).json({ error: "operation not found" });
      return;
    }
    res.json(op);
  });

  app.get("/v1/operations", (_req, res) => {
    res.json({ operations: deps.supervisor.recentOperations() });
  });

  const server = app.listen(deps.port, () => {
    deps.log(`[supervisor] listening on :${deps.port}`);
  });
  return {
    stop: () => server.close(),
    port: () => {
      const addr = server.address();
      return typeof addr === "object" && addr ? addr.port : deps.port;
    },
  };
}

function parseSettings(body: unknown): RuntimeSettings {
  if (body == null || typeof body !== "object") return {};
  const raw = body as { settings?: unknown; hostPorts?: unknown; env?: unknown; selfId?: unknown };
  const source = (raw.settings ?? raw) as { hostPorts?: unknown; env?: unknown; selfId?: unknown };
  const settings: RuntimeSettings = {};

  if (source.hostPorts != null) {
    if (typeof source.hostPorts !== "object") throw new ConfigError("hostPorts 必须是对象", ["hostPorts"]);
    const hp = source.hostPorts as { webui?: unknown; novnc?: unknown };
    settings.hostPorts = {};
    for (const key of ["webui", "novnc"] as const) {
      const v = hp[key];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
        throw new ConfigError(`hostPorts.${key} 必须是 1-65535 的整数`, [`hostPorts.${key}`]);
      }
      settings.hostPorts[key] = v;
    }
  }

  if (source.env != null) {
    if (typeof source.env !== "object" || Array.isArray(source.env)) {
      throw new ConfigError("env 必须是对象", ["env"]);
    }
    settings.env = {};
    for (const [k, v] of Object.entries(source.env as Record<string, unknown>)) {
      if (typeof v !== "string") throw new ConfigError(`env.${k} 必须是字符串`, [`env.${k}`]);
      settings.env[k] = v;
    }
  }

  if (source.selfId !== undefined) {
    if (typeof source.selfId !== "number" || !Number.isFinite(source.selfId) || source.selfId < 0) {
      throw new ConfigError("selfId 必须是非负数字", ["selfId"]);
    }
    settings.selfId = Math.round(source.selfId);
  }
  return settings;
}

async function assertNoPortConflict(
  supervisor: RuntimeSupervisor,
  id: keyof typeof RUNTIME_DEFINITIONS,
  settings: RuntimeSettings,
): Promise<void> {
  const requested = settings.hostPorts;
  if (!requested) return;
  // 只有「另一套容器已经存在」才会真正抢端口;未安装的 runtime 用默认端口不算冲突
  const others = (await supervisor.list()).filter((r) => r.id !== id && r.install === "installed");
  for (const other of others) {
    for (const [kind, port] of Object.entries(requested)) {
      if (port === undefined) continue;
      if (other.hostPorts[kind] === port) {
        throw new ConfigError(`宿主端口 ${port} 已被 ${other.id} 占用`, [`hostPorts.${kind}`]);
      }
    }
  }
}

function respondError(res: express.Response, err: unknown): void {
  if (err instanceof ConfigError) {
    res.status(400).json({ error: err.message, issues: err.issues });
    return;
  }
  res.status(500).json({ error: messageOf(err) });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
