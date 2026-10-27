import { randomUUID } from "node:crypto";
import type { RuntimeId, RuntimeStatusView } from "../plugins/types.js";
import { ConfigError } from "../config-schema.js";
import { specHash, type ContainerInfo, type DockerEngine } from "./docker.js";
import {
  RUNTIME_DEFINITIONS,
  SUPERVISOR_NETWORK,
  buildContainerSpec,
  isRuntimeId,
  runtimeIds,
  type ContainerSpec,
  type RuntimeSettings,
} from "./registry.js";

export interface Operation {
  id: string;
  runtime: RuntimeId;
  action: string;
  stage: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface SupervisorOptions {
  engine: DockerEngine;
  network?: string;
  log?: (msg: string) => void;
  /** 下拉镜像/启动的超时,防止操作永久挂住 */
  operationTimeoutMs?: number;
}

/**
 * Runtime 协调器:install / start / stop / restart / recreate。
 *
 * 三条不变量:
 * 1. 同一 runtime 的操作单飞(安装/停止/重启不会互相踩);
 * 2. 配置 hash 未变就复用现有容器,不无谓重建;
 * 3. 重建只删容器不删卷 —— 登录态与数据不能因为换端口丢失。
 */
export class RuntimeSupervisor {
  private readonly ops = new Map<string, Promise<unknown>>();
  private readonly operations = new Map<string, Operation>();
  private readonly lastErrors = new Map<RuntimeId, string>();
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: SupervisorOptions) {
    this.log = opts.log ?? (() => {});
  }

  list(): Promise<RuntimeStatusView[]> {
    return Promise.all(runtimeIds().map((id) => this.inspect(id)));
  }

  /**
   * 读取 runtime 的只读配置文件。逻辑名必须在 registry 的 readableFiles 白名单里,
   * 路径完全由服务端决定 —— 调用方无法传入任意路径。
   */
  async readFile(id: RuntimeId, key: string): Promise<string> {
    const def = RUNTIME_DEFINITIONS[id];
    const candidates = def.readableFiles[key];
    if (!candidates?.length) {
      throw new ConfigError(`${id}: 不允许读取 ${key}`, [`files.${key} 不在白名单`]);
    }
    const info = await this.opts.engine.inspectContainer(def.containerName);
    if (!info) throw new ConfigError(`${id} 容器未安装,无法读取 ${key}`, ["容器不存在"]);
    if (info.state !== "running") throw new ConfigError(`${id} 容器未运行,无法读取 ${key}`, [`当前状态 ${info.state}`]);
    let lastErr: unknown;
    for (const candidate of candidates) {
      try {
        const content = await this.opts.engine.readContainerFile(def.containerName, candidate);
        if (content.trim()) return content;
      } catch (err) {
        lastErr = err;
      }
    }
    throw new ConfigError(`${id}: 读取 ${key} 失败`, [String(lastErr ?? "所有候选路径均为空")]);
  }

  async inspect(id: RuntimeId): Promise<RuntimeStatusView> {
    const def = RUNTIME_DEFINITIONS[id];
    const container = await this.opts.engine.inspectContainer(def.containerName);
    const op = [...this.operations.values()].filter((o) => o.runtime === id && !o.finishedAt).at(-1);
    return this.view(id, container, container ? "installed" : "not_installed", op);
  }

  install(id: RuntimeId, settings: RuntimeSettings = {}): Promise<RuntimeStatusView> {
    return this.serialize(id, "install", async () => {
      await this.ensureContainer(id, settings);
      return this.inspect(id);
    });
  }

  start(id: RuntimeId, settings: RuntimeSettings = {}): Promise<RuntimeStatusView> {
    return this.serialize(id, "start", async () => {
      const spec = await this.ensureContainer(id, settings);
      const container = await this.opts.engine.inspectContainer(spec.name);
      if (container?.state !== "running") {
        this.log(`[supervisor] 启动 ${id}`);
        await this.opts.engine.startContainer(spec.name);
      }
      return this.inspect(id);
    });
  }

  stop(id: RuntimeId): Promise<RuntimeStatusView> {
    return this.serialize(id, "stop", async () => {
      const def = RUNTIME_DEFINITIONS[id];
      const container = await this.opts.engine.inspectContainer(def.containerName);
      if (container && container.state === "running") {
        this.log(`[supervisor] 停止 ${id}`);
        await this.opts.engine.stopContainer(def.containerName);
      }
      return this.inspect(id);
    });
  }

  restart(id: RuntimeId, settings: RuntimeSettings = {}): Promise<RuntimeStatusView> {
    return this.serialize(id, "restart", async () => {
      const spec = await this.ensureContainer(id, settings);
      const container = await this.opts.engine.inspectContainer(spec.name);
      this.log(`[supervisor] 重启 ${id}`);
      if (container?.state === "running") await this.opts.engine.restartContainer(spec.name);
      else await this.opts.engine.startContainer(spec.name);
      return this.inspect(id);
    });
  }

  recreate(id: RuntimeId, settings: RuntimeSettings = {}): Promise<RuntimeStatusView> {
    return this.serialize(id, "recreate", async () => {
      const def = RUNTIME_DEFINITIONS[id];
      const spec = buildContainerSpec(id, settings);
      const container = await this.opts.engine.inspectContainer(def.containerName);
      if (container) {
        if (container.state === "running") await this.opts.engine.stopContainer(def.containerName);
        // v=false:保留数据卷
        await this.opts.engine.removeContainer(def.containerName);
      }
      await this.ensureNetwork();
      await this.pullIfMissing(spec);
      await this.opts.engine.createContainer(spec);
      await this.opts.engine.startContainer(spec.name);
      return this.inspect(id);
    });
  }

  async logs(id: RuntimeId, tail = 200): Promise<string> {
    const def = RUNTIME_DEFINITIONS[id];
    const container = await this.opts.engine.inspectContainer(def.containerName);
    if (!container) throw new ConfigError(`${id} 尚未安装`, ["runtime"]);
    return this.opts.engine.logs(def.containerName, tail);
  }

  operation(id: string): Operation | null {
    return this.operations.get(id) ?? null;
  }

  recentOperations(limit = 50): Operation[] {
    return [...this.operations.values()].slice(-limit);
  }

  // ---------- 内部 ----------

  private async ensureContainer(id: RuntimeId, settings: RuntimeSettings): Promise<ContainerSpec> {
    const spec = buildContainerSpec(id, settings);
    await this.ensureNetwork();
    await this.pullIfMissing(spec);

    const existing = await this.opts.engine.inspectContainer(spec.name);
    if (existing) {
      const desired = specHash(spec);
      const actual = existing.labels["watching-bot.spec-hash"];
      if (actual === desired) return spec;
      // 端口/安全/镜像变了才重建;卷不动
      this.log(`[supervisor] ${id} 配置变更,重建容器(保留卷)`);
      if (existing.state === "running") await this.opts.engine.stopContainer(spec.name);
      await this.opts.engine.removeContainer(spec.name);
    }
    this.log(`[supervisor] 创建 ${id} 容器 ${spec.name}`);
    await this.opts.engine.createContainer(spec);
    return spec;
  }

  private async pullIfMissing(spec: ContainerSpec): Promise<void> {
    if (await this.opts.engine.imageExists(spec.image)) return;
    this.log(`[supervisor] 拉取镜像 ${spec.image}`);
    await this.opts.engine.pullImage(spec.image);
  }

  private async ensureNetwork(): Promise<void> {
    await this.opts.engine.ensureNetwork(this.opts.network ?? SUPERVISOR_NETWORK);
  }

  private serialize(id: RuntimeId, action: string, fn: (op: Operation) => Promise<RuntimeStatusView>): Promise<RuntimeStatusView> {
    const key = `runtime:${id}`;
    const prev = this.ops.get(key) ?? Promise.resolve();
    const op: Operation = {
      id: randomUUID(),
      runtime: id,
      action,
      stage: "queued",
      startedAt: Date.now(),
    };
    this.operations.set(op.id, op);

    const run = prev
      .catch(() => {})
      .then(async () => {
        op.stage = action;
        this.lastErrors.delete(id);
        try {
          return await withTimeout(
            fn(op),
            this.opts.operationTimeoutMs ?? 10 * 60_000,
            `runtime ${id} ${action} 超时`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          op.error = message;
          this.lastErrors.set(id, message);
          this.log(`[supervisor] ${id} ${action} 失败: ${message}`);
          throw err;
        } finally {
          op.finishedAt = Date.now();
          op.stage = op.error ? "failed" : "done";
        }
      });

    this.ops.set(key, run);
    void run.then(
      () => {
        if (this.ops.get(key) === run) this.ops.delete(key);
      },
      () => {
        if (this.ops.get(key) === run) this.ops.delete(key);
      },
    );
    return run;
  }

  private view(
    id: RuntimeId,
    container: ContainerInfo | null,
    install: RuntimeStatusView["install"],
    op: Operation | undefined,
  ): RuntimeStatusView {
    const def = RUNTIME_DEFINITIONS[id];
    const process: RuntimeStatusView["process"] = !container
      ? "stopped"
      : container.state === "running"
        ? "running"
        : container.state === "restarting"
          ? "restarting"
          : "stopped";

    const hostPorts: Record<string, number> = {};
    for (const p of def.ports) {
      hostPorts[p.kind] = container?.publishedPorts[p.containerPort] ?? p.defaultHostPort;
    }

    return {
      id,
      install,
      process,
      image: def.image,
      containerName: def.containerName,
      hostPorts,
      health: container?.state === "running" ? "running" : container?.state,
      lastError: this.lastErrors.get(id),
      operation: op ? { id: op.id, stage: op.stage } : undefined,
    };
  }
}

export function parseRuntimeId(value: unknown): RuntimeId {
  if (!isRuntimeId(value)) throw new ConfigError("runtime 必须是 napcat 或 snowluma", ["runtime"]);
  return value;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
