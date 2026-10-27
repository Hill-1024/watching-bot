import { HttpDockerEngine } from "./docker.js";
import { startSupervisorServer } from "./server.js";
import { RuntimeSupervisor } from "./supervisor.js";

/**
 * runtime-supervisor 进程入口(独立容器,唯一挂载 Docker socket 的组件)。
 *
 * 环境变量:
 *   WATCHING_BOT_SUPERVISOR_PORT  监听端口(默认 8099)
 *   WATCHING_BOT_SUPERVISOR_TOKEN 必填,内部认证 secret
 *   DOCKER_SOCKET                 Docker socket(默认 /var/run/docker.sock)
 */
const port = Number(process.env.WATCHING_BOT_SUPERVISOR_PORT ?? 8099);
const token = (process.env.WATCHING_BOT_SUPERVISOR_TOKEN ?? "").trim();
const socketPath = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

try {
  const engine = new HttpDockerEngine(socketPath);
  const supervisor = new RuntimeSupervisor({ engine, log });
  startSupervisorServer({ supervisor, port, token, log });
} catch (err) {
  console.error("supervisor 启动失败:", err instanceof Error ? err.message : err);
  process.exit(1);
}
