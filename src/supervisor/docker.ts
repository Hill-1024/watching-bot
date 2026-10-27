import { createHash } from "node:crypto";
import { request } from "node:http";
import type { ContainerSpec } from "./registry.js";
import { SUPERVISOR_NETWORK } from "./registry.js";

export interface ContainerInfo {
  name: string;
  image: string;
  state: "running" | "exited" | "created" | "restarting" | "dead" | "paused" | "unknown";
  labels: Record<string, string>;
  /** 容器端口 → 宿主端口 */
  publishedPorts: Record<number, number>;
  startedAt?: string;
}

export interface DockerEngine {
  imageExists(image: string): Promise<boolean>;
  pullImage(image: string): Promise<void>;
  inspectContainer(name: string): Promise<ContainerInfo | null>;
  createContainer(spec: ContainerSpec): Promise<void>;
  startContainer(name: string): Promise<void>;
  stopContainer(name: string, timeoutSec?: number): Promise<void>;
  restartContainer(name: string, timeoutSec?: number): Promise<void>;
  removeContainer(name: string): Promise<void>;
  logs(name: string, tail: number): Promise<string>;
  /** 读取容器内单个文件(仅用于 registry 白名单里的配置路径) */
  readContainerFile(name: string, path: string): Promise<string>;
  ensureNetwork(name: string): Promise<void>;
}

/** 规格指纹:配置没变就复用容器,避免每次启动都重建 */
export function specHash(spec: ContainerSpec): string {
  const stable = JSON.stringify({
    image: spec.image,
    env: Object.entries(spec.env).sort(([a], [b]) => a.localeCompare(b)),
    volumes: spec.volumes,
    ports: spec.ports,
    shm: spec.shmSizeBytes ?? 0,
    capAdd: spec.capAdd,
    securityOpt: spec.securityOpt,
    ulimits: spec.ulimits,
    restart: spec.restartPolicy,
    aliases: spec.aliases,
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

/**
 * Docker Engine API 客户端(仅 unix socket)。
 * 只实现 supervisor 白名单需要的那几个端点,不暴露任意 Docker 命令。
 */
export class HttpDockerEngine implements DockerEngine {
  constructor(private readonly socketPath = "/var/run/docker.sock") {}

  async imageExists(image: string): Promise<boolean> {
    const res = await this.call("GET", `/images/${encodeURIComponent(image)}/json`, undefined, true);
    return res.status === 200;
  }

  async pullImage(image: string): Promise<void> {
    const [name, tag = "latest"] = image.split(":");
    const res = await this.call(
      "POST",
      `/images/create?fromImage=${encodeURIComponent(name!)}&tag=${encodeURIComponent(tag)}`,
      undefined,
      true,
    );
    const body = await res.text();
    if (res.status >= 400) throw new Error(`拉取镜像失败 ${image}: ${trim(body)}`);
    // Docker 的拉取流里错误以 JSON 行返回,HTTP 仍是 200
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { error?: string; errorDetail?: { message?: string } };
        const err = parsed.errorDetail?.message ?? parsed.error;
        if (err) throw new Error(`拉取镜像失败 ${image}: ${err}`);
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }

  async inspectContainer(name: string): Promise<ContainerInfo | null> {
    const res = await this.call("GET", `/containers/${encodeURIComponent(name)}/json`, undefined, true);
    if (res.status === 404) return null;
    const body = await res.json();
    if (res.status >= 400) throw new Error(`inspect ${name} 失败: ${trim(JSON.stringify(body))}`);
    return toContainerInfo(body as DockerInspect);
  }

  async createContainer(spec: ContainerSpec): Promise<void> {
    const portBindings: Record<string, { HostIp: string; HostPort: string }[]> = {};
    for (const p of spec.ports) {
      portBindings[`${p.containerPort}/tcp`] = [{ HostIp: p.hostIp, HostPort: String(p.hostPort) }];
    }
    const body = {
      Image: spec.image,
      Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
      Labels: { ...spec.labels, "watching-bot.spec-hash": specHash(spec) },
      Hostname: spec.aliases[0] ?? spec.name,
      HostConfig: {
        Binds: spec.volumes.map((v) => `${v.volume}:${v.containerPath}`),
        PortBindings: portBindings,
        ShmSize: spec.shmSizeBytes ?? 0,
        CapAdd: spec.capAdd,
        SecurityOpt: spec.securityOpt,
        Ulimits: spec.ulimits.map((u) => ({ Name: u.name, Soft: u.soft, Hard: u.hard })),
        RestartPolicy: { Name: spec.restartPolicy },
        NetworkMode: SUPERVISOR_NETWORK,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [SUPERVISOR_NETWORK]: { Aliases: spec.aliases },
        },
      },
    };
    const res = await this.call("POST", `/containers/create?name=${encodeURIComponent(spec.name)}`, body, true);
    if (res.status >= 400) throw new Error(`创建容器失败: ${trim(await res.text())}`);
  }

  async startContainer(name: string): Promise<void> {
    const res = await this.call("POST", `/containers/${encodeURIComponent(name)}/start`, undefined, true);
    if (res.status >= 400 && res.status !== 304) {
      throw new Error(`启动容器失败: ${trim(await res.text())}`);
    }
  }

  async stopContainer(name: string, timeoutSec = 10): Promise<void> {
    const res = await this.call(
      "POST",
      `/containers/${encodeURIComponent(name)}/stop?t=${timeoutSec}`,
      undefined,
      true,
    );
    if (res.status >= 400 && res.status !== 304) {
      throw new Error(`停止容器失败: ${trim(await res.text())}`);
    }
  }

  async restartContainer(name: string, timeoutSec = 10): Promise<void> {
    const res = await this.call(
      "POST",
      `/containers/${encodeURIComponent(name)}/restart?t=${timeoutSec}`,
      undefined,
      true,
    );
    if (res.status >= 400) throw new Error(`重启容器失败: ${trim(await res.text())}`);
  }

  async removeContainer(name: string): Promise<void> {
    const res = await this.call("DELETE", `/containers/${encodeURIComponent(name)}?force=true&v=false`, undefined, true);
    if (res.status >= 400 && res.status !== 404) {
      throw new Error(`删除容器失败: ${trim(await res.text())}`);
    }
  }

  async logs(name: string, tail: number): Promise<string> {
    const res = await this.call(
      "GET",
      `/containers/${encodeURIComponent(name)}/logs?stdout=true&stderr=true&tail=${Math.max(1, Math.min(5000, tail))}`,
      undefined,
      true,
    );
    if (res.status >= 400) throw new Error(`读取日志失败: ${trim(await res.text())}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return demux(buf).slice(-200_000);
  }

  /** Docker exec：读取容器内文件。path 可含通配符(取最近修改的一个);只接受 registry 里的常量路径。 */
  async readContainerFile(name: string, path: string): Promise<string> {
    // 通配符由 ls 展开并按 mtime 取最新;路径来自服务端常量,不接受调用方任意输入
    const script = `f=$(ls -1t ${path} 2>/dev/null | head -n 1); [ -n "$f" ] || exit 3; cat "$f"`;
    const created = await this.call(
      "POST",
      `/containers/${encodeURIComponent(name)}/exec`,
      { AttachStdout: true, AttachStderr: true, Cmd: ["sh", "-c", script] },
      true,
    );
    if (created.status >= 400) throw new Error(`创建 exec 失败: ${trim(await created.text())}`);
    const execId = (await created.json() as { Id?: string } | null)?.Id;
    if (!execId) throw new Error("exec 未返回 Id");

    const started = await this.call("POST", `/exec/${encodeURIComponent(execId)}/start`, { Detach: false, Tty: false }, true);
    if (started.status >= 400) throw new Error(`启动 exec 失败: ${trim(await started.text())}`);
    const out = demux(Buffer.from(await started.arrayBuffer()));

    const info = await this.call("GET", `/exec/${encodeURIComponent(execId)}/json`, undefined, true);
    const exitCode = (await info.json() as { ExitCode?: number } | null)?.ExitCode;
    if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
      throw new Error(`读取失败(exit ${exitCode}): ${trim(out)}`);
    }
    return out;
  }

  async ensureNetwork(name: string): Promise<void> {
    const res = await this.call("GET", `/networks/${encodeURIComponent(name)}`, undefined, true);
    if (res.status === 200) return;
    const create = await this.call("POST", "/networks/create", { Name: name, Driver: "bridge" }, true);
    if (create.status >= 400 && create.status !== 409) {
      throw new Error(`创建网络失败: ${trim(await create.text())}`);
    }
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    shortLived = false,
  ): Promise<DockerResponse> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise<DockerResponse>((resolvePromise, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: {
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": String(payload.length) } : {}),
          },
          timeout: shortLived ? 120_000 : 0,
        },
        (res) => {
          resolvePromise(new DockerResponse(res.statusCode ?? 0, res));
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error(`Docker API 超时: ${method} ${path}`));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}

class DockerResponse {
  constructor(
    readonly status: number,
    private readonly res: import("node:http").IncomingMessage,
  ) {}

  async text(): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      this.res.on("data", (c: Buffer) => chunks.push(c));
      this.res.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf-8")));
      this.res.on("error", reject);
    });
  }

  async json(): Promise<unknown> {
    const text = await this.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      this.res.on("data", (c: Buffer) => chunks.push(c));
      this.res.on("end", () => {
        // Buffer.concat 的底层 ArrayBuffer 可能是 8KB 共享池,必须按 byteOffset/byteLength 切片,
        // 否则会把池里的无关字节一起返回(exec 读配置时表现为 JSON 尾部多出垃圾)。
        const buf = Buffer.concat(chunks);
        resolvePromise(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      });
      this.res.on("error", reject);
    });
  }
}

interface DockerInspect {
  Id?: string;
  Name?: string;
  Config?: { Image?: string; Labels?: Record<string, string> };
  State?: { Status?: string; StartedAt?: string };
  NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[] | null> };
}

function toContainerInfo(raw: DockerInspect): ContainerInfo {
  const status = raw.State?.Status ?? "unknown";
  const state: ContainerInfo["state"] =
    status === "running" || status === "exited" || status === "created" || status === "restarting" ||
    status === "dead" || status === "paused"
      ? status
      : "unknown";
  const publishedPorts: Record<number, number> = {};
  for (const [key, bindings] of Object.entries(raw.NetworkSettings?.Ports ?? {})) {
    const containerPort = Number(key.split("/")[0]);
    const hostPort = Number(bindings?.[0]?.HostPort);
    if (Number.isFinite(containerPort) && Number.isFinite(hostPort)) publishedPorts[containerPort] = hostPort;
  }
  return {
    name: (raw.Name ?? "").replace(/^\//, ""),
    image: raw.Config?.Image ?? "",
    state,
    labels: raw.Config?.Labels ?? {},
    publishedPorts,
    startedAt: raw.State?.StartedAt,
  };
}

/** Docker 多路复用流:8 字节头(stream type + 3 保留 + uint32 长度)+ payload */
function demux(buf: Buffer): string {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 8 <= buf.length) {
    const type = buf[offset];
    const len = buf.readUInt32BE(offset + 4);
    if (type !== 1 && type !== 2) break;
    const start = offset + 8;
    const end = start + len;
    if (end > buf.length) break;
    out.push(buf.subarray(start, end));
    offset = end;
  }
  if (out.length === 0) return buf.toString("utf-8");
  return Buffer.concat(out).toString("utf-8");
}

function trim(text: string): string {
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
