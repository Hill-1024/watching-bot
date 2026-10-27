import type { RestrictedSupervisorClient, RuntimeId, RuntimeStatusView } from "../plugins/types.js";

/**
 * Supervisor 的受限客户端。
 *
 * 只暴露 runtime ID 级操作 —— 没有 image、没有 cmd、没有 bind mount。
 * 插件拿到的就是这个接口,而不是 Docker 本身。
 */
export class SupervisorClient implements RestrictedSupervisorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 10 * 60_000,
  ) {}

  list(): Promise<RuntimeStatusView[]> {
    return this.call<{ runtimes: RuntimeStatusView[] }>("GET", "/v1/runtimes").then((r) => r.runtimes);
  }

  inspect(id: RuntimeId): Promise<RuntimeStatusView> {
    return this.call<RuntimeStatusView>("GET", `/v1/runtimes/${id}`);
  }

  install(id: RuntimeId): Promise<RuntimeStatusView> {
    return this.call<RuntimeStatusView>("POST", `/v1/runtimes/${id}/install`, {});
  }

  start(id: RuntimeId): Promise<RuntimeStatusView> {
    return this.call<RuntimeStatusView>("POST", `/v1/runtimes/${id}/start`, {});
  }

  stop(id: RuntimeId): Promise<RuntimeStatusView> {
    return this.call<RuntimeStatusView>("POST", `/v1/runtimes/${id}/stop`, {});
  }

  restart(id: RuntimeId): Promise<RuntimeStatusView> {
    return this.call<RuntimeStatusView>("POST", `/v1/runtimes/${id}/restart`, {});
  }

  recreate(id: RuntimeId, settings?: Record<string, unknown>): Promise<RuntimeStatusView> {
    return this.call<RuntimeStatusView>("POST", `/v1/runtimes/${id}/recreate`, settings ?? {});
  }

  async logs(id: RuntimeId, tail = 200): Promise<string> {
    const r = await this.call<{ logs: string }>("GET", `/v1/runtimes/${id}/logs?tail=${tail}`);
    return r.logs;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new Error(`无法连接 runtime supervisor(${url}): ${String(err)}`);
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* 非 JSON 响应按原文报错 */
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : text.slice(0, 300);
      throw new Error(`supervisor ${method} ${path} → ${res.status}: ${detail}`);
    }
    return parsed as T;
  }
}
