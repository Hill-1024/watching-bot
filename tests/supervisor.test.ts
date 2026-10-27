import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config-schema.js";
import type { ContainerInfo, DockerEngine } from "../src/supervisor/docker.js";
import { specHash } from "../src/supervisor/docker.js";
import { SUPERVISOR_NETWORK, buildContainerSpec } from "../src/supervisor/registry.js";
import { RuntimeSupervisor } from "../src/supervisor/supervisor.js";
import { startSupervisorServer } from "../src/supervisor/server.js";

/** 可编程的 Docker 假引擎:验证调用顺序、单飞、配置复用,不需要真的 Docker */
class FakeDocker implements DockerEngine {
  calls: string[] = [];
  images = new Set<string>();
  containers = new Map<string, { spec?: ReturnType<typeof buildContainerSpec>; state: ContainerInfo["state"] }>();
  pullDelayMs = 0;

  async imageExists(image: string): Promise<boolean> {
    return this.images.has(image);
  }

  async pullImage(image: string): Promise<void> {
    this.calls.push(`pull:${image}`);
    if (this.pullDelayMs) await new Promise((r) => setTimeout(r, this.pullDelayMs));
    this.images.add(image);
  }

  async inspectContainer(name: string): Promise<ContainerInfo | null> {
    this.calls.push(`inspect:${name}`);
    const c = this.containers.get(name);
    if (!c) return null;
    const ports: Record<number, number> = {};
    for (const p of c.spec?.ports ?? []) ports[p.containerPort] = p.hostPort;
    return {
      name,
      image: c.spec?.image ?? "",
      state: c.state,
      labels: c.spec ? { ...c.spec.labels, "watching-bot.spec-hash": specHash(c.spec) } : {},
      publishedPorts: ports,
    };
  }

  async createContainer(spec: ReturnType<typeof buildContainerSpec>): Promise<void> {
    this.calls.push(`create:${spec.name}`);
    this.containers.set(spec.name, { spec, state: "created" });
  }

  async startContainer(name: string): Promise<void> {
    this.calls.push(`start:${name}`);
    const c = this.containers.get(name);
    if (c) c.state = "running";
  }

  async stopContainer(name: string): Promise<void> {
    this.calls.push(`stop:${name}`);
    const c = this.containers.get(name);
    if (c) c.state = "exited";
  }

  async restartContainer(name: string): Promise<void> {
    this.calls.push(`restart:${name}`);
    const c = this.containers.get(name);
    if (c) c.state = "running";
  }

  async removeContainer(name: string): Promise<void> {
    this.calls.push(`remove:${name}`);
    this.containers.delete(name);
  }

  async logs(name: string, tail: number): Promise<string> {
    return `logs of ${name} (tail ${tail})`;
  }

  async ensureNetwork(name: string): Promise<void> {
    this.calls.push(`network:${name}`);
  }

  count(prefix: string): number {
    return this.calls.filter((c) => c.startsWith(prefix)).length;
  }
}

function supervisorWith(engine: FakeDocker) {
  return new RuntimeSupervisor({ engine, log: () => {}, operationTimeoutMs: 5000 });
}

describe("Runtime 规格:白名单与安全默认值", () => {
  it("NapCat 只暴露 loopback WebUI,不发布 OneBot 端口", () => {
    const spec = buildContainerSpec("napcat");
    expect(spec.image).toContain("napcat");
    expect(spec.ports).toEqual([{ containerPort: 6099, hostPort: 6099, hostIp: "127.0.0.1" }]);
    expect(spec.ports.some((p) => p.containerPort === 3001)).toBe(false);
    expect(spec.volumes.map((v) => v.volume)).toContain("watching-qq-napcat-config");
  });

  it("SnowLuma 带上官方要求的卷、shm、SYS_PTRACE 与 seccomp", () => {
    const spec = buildContainerSpec("snowluma");
    expect(spec.image).toContain("snowluma");
    expect(spec.volumes.map((v) => v.containerPath).sort()).toEqual([
      "/app/.config",
      "/app/.local/share",
      "/app/data",
    ]);
    expect(spec.shmSizeBytes).toBe(1024 * 1024 * 1024);
    expect(spec.capAdd).toContain("SYS_PTRACE");
    expect(spec.securityOpt).toContain("seccomp=unconfined");
    expect(spec.ports.map((p) => p.containerPort).sort()).toEqual([5099, 6081]);
    expect(spec.ports.every((p) => p.hostIp === "127.0.0.1")).toBe(true);
  });

  it("非法端口/环境变量被拒绝(不能借此传 image 或 bind mount)", () => {
    expect(() => buildContainerSpec("napcat", { hostPorts: { webui: 0 } })).toThrow(ConfigError);
    expect(() => buildContainerSpec("napcat", { hostPorts: { webui: 70000 } })).toThrow(ConfigError);
    expect(() => buildContainerSpec("napcat", { env: { EVIL: "x" } })).toThrow(/不允许的环境变量/);
    expect(() => buildContainerSpec("snowluma", { env: { QQ_ACCOUNT: "1\nrm -rf /" } })).toThrow(ConfigError);
  });

  it("同一 runtime 内的宿主端口不能重复", () => {
    expect(() => buildContainerSpec("snowluma", { hostPorts: { webui: 5099, novnc: 5099 } })).toThrow(/重复/);
  });
});

describe("RuntimeSupervisor:安装/启动/停止", () => {
  it("首次安装拉镜像并创建容器,但不自动启动", async () => {
    const engine = new FakeDocker();
    const sup = supervisorWith(engine);
    const status = await sup.install("napcat");
    expect(engine.count("pull:")).toBe(1);
    expect(engine.count("create:")).toBe(1);
    expect(engine.count("start:")).toBe(0);
    expect(status.install).toBe("installed");
    expect(status.process).toBe("stopped");
  });

  it("重复安装复用现有容器,不重复拉取/创建", async () => {
    const engine = new FakeDocker();
    const sup = supervisorWith(engine);
    await sup.install("napcat");
    const before = engine.calls.length;
    await sup.install("napcat");
    expect(engine.count("pull:")).toBe(1);
    expect(engine.count("create:")).toBe(1);
    expect(engine.calls.length).toBeGreaterThanOrEqual(before);
  });

  it("start/stop 推进容器状态", async () => {
    const engine = new FakeDocker();
    const sup = supervisorWith(engine);
    const started = await sup.start("napcat");
    expect(started.process).toBe("running");
    const stopped = await sup.stop("napcat");
    expect(stopped.process).toBe("stopped");
    expect(engine.count("stop:")).toBe(1);
  });

  it("宿主端口变化才重建容器,数据卷不删", async () => {
    const engine = new FakeDocker();
    const sup = supervisorWith(engine);
    await sup.start("snowluma");
    expect(engine.count("create:")).toBe(1);
    expect(engine.count("remove:")).toBe(0);

    await sup.start("snowluma", { hostPorts: { webui: 15099, novnc: 16081 } });
    expect(engine.count("remove:")).toBe(1);
    expect(engine.count("create:")).toBe(2);
    const spec = engine.containers.get("watching-qq-snowluma")!.spec!;
    expect(spec.ports.map((p) => p.hostPort).sort()).toEqual([15099, 16081]);
    expect(spec.volumes.map((v) => v.volume)).toContain("watching-qq-snowluma-data");
    // remove 只删容器;卷名仍在 spec 里,说明重建不会清数据
    expect(engine.calls.indexOf("remove:watching-qq-snowluma")).toBeLessThan(
      engine.calls.lastIndexOf("create:watching-qq-snowluma"),
    );
  });

  it("并发安装同一 runtime 只拉一次镜像(单飞)", async () => {
    const engine = new FakeDocker();
    engine.pullDelayMs = 20;
    const sup = supervisorWith(engine);
    await Promise.all([sup.install("napcat"), sup.install("napcat"), sup.install("napcat")]);
    expect(engine.count("pull:")).toBe(1);
    expect(engine.count("create:")).toBe(1);
  });

  it("失败被记录在状态里而不是静默吞掉", async () => {
    const engine = new FakeDocker();
    engine.createContainer = async () => {
      throw new Error("port already allocated");
    };
    const sup = supervisorWith(engine);
    await expect(sup.install("napcat")).rejects.toThrow(/port already allocated/);
    const status = await sup.inspect("napcat");
    expect(status.lastError).toContain("port already allocated");
    expect(status.install).toBe("not_installed");
  });
});

describe("Supervisor HTTP:语法糖之外的安全边界", () => {
  it("没有 token 拒绝启动(它等价于 Docker 高权限)", () => {
    const engine = new FakeDocker();
    expect(() =>
      startSupervisorServer({ supervisor: supervisorWith(engine), port: 0, token: "", log: () => {} }),
    ).toThrow(/SUPERVISOR_TOKEN/);
  });

  it("Bearer token 校验、runtime 白名单与端口校验", async () => {
    const engine = new FakeDocker();
    const sup = supervisorWith(engine);
    const server = startSupervisorServer({ supervisor: sup, port: 0, token: "secret", log: () => {} });
    const base = `http://127.0.0.1:${server.port()}`;
    const auth = { Authorization: "Bearer secret", "Content-Type": "application/json" };
    try {
      expect((await fetch(`${base}/v1/runtimes`)).status).toBe(401);
      expect((await fetch(`${base}/v1/runtimes`, { headers: auth })).status).toBe(200);

      const badRuntime = await fetch(`${base}/v1/runtimes/docker/install`, {
        method: "POST",
        headers: auth,
        body: "{}",
      });
      expect(badRuntime.status).toBe(400);

      const badPort = await fetch(`${base}/v1/runtimes/napcat/install`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ hostPorts: { webui: 99999 } }),
      });
      expect(badPort.status).toBe(400);
      const payload = (await badPort.json()) as { issues?: string[] };
      expect(payload.issues?.[0]).toContain("hostPorts.webui");

      // 任意 image / 命令 / bind mount 输入不会进入 spec
      const ok = await fetch(`${base}/v1/runtimes/napcat/install`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ image: "evil:latest", cmd: ["rm", "-rf"], binds: ["/:/host"] }),
      });
      expect(ok.status).toBe(200);
      const spec = engine.containers.get("watching-qq-napcat")!.spec!;
      expect(spec.image).toContain("napcat");
      expect(spec.volumes.every((v) => v.volume.startsWith("watching-qq-"))).toBe(true);
    } finally {
      server.stop();
    }
  });

  it("操作 ID 可查询,日志可读取", async () => {
    const engine = new FakeDocker();
    const sup = supervisorWith(engine);
    await sup.start("napcat");
    const ops = sup.recentOperations();
    expect(ops.length).toBeGreaterThan(0);
    expect(ops[0]!.runtime).toBe("napcat");
    await expect(sup.logs("napcat", 10)).resolves.toContain("logs of");
  });
});
