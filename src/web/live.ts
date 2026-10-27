import type express from "express";
import { fmtSim } from "../core/clock.js";
import type { AgentCore } from "../core/loop.js";

/**
 * 事件推送通道(SSE)。
 *
 * 设计要点:
 * 1. 服务端只在「真的有变化」时推一条,不按固定频率刷;
 * 2. topic 把「谁变了」说清楚,前端只有订阅了该 topic 的页面才会拉数据;
 * 3. 不把长期 token 放进 URL —— 前端用 fetch 流式读取,自带 Authorization。
 */

export type LiveTopic =
  | "status"
  | "state"
  | "activity"
  | "injections"
  | "usage"
  | "memory"
  | "plugins"
  | "resync"
  | `plugin:${string}`;

export interface LiveEvent {
  topic: string;
  seq: number;
  at: number;
  data?: unknown;
}

interface Client {
  send(event: LiveEvent): void;
}

export class LiveHub {
  private clients = new Set<Client>();
  private seq = 0;

  add(client: Client): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  publish(topic: string, data?: unknown): void {
    if (this.clients.size === 0) return;
    const event: LiveEvent = { topic, seq: ++this.seq, at: Date.now(), ...(data === undefined ? {} : { data }) };
    for (const client of [...this.clients]) {
      try {
        client.send(event);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  get subscribers(): number {
    return this.clients.size;
  }
}

/** 同一个快照既供 GET /api/status 初始加载,也供 SSE 增量推送 */
export interface StatusSnapshotDeps {
  clock: { simNow(): number; timeScale: number };
  core: AgentCore;
  state: { pulseView(): unknown };
}

export function statusSnapshot(deps: StatusSnapshotDeps): Record<string, unknown> {
  const simMs = deps.clock.simNow();
  const snap = deps.core.snapshotNow();
  return {
    sim: fmtSim(simMs),
    simMs,
    realMs: Date.now(),
    timeScale: deps.clock.timeScale,
    phase: deps.core.machine.phase,
    sleepStartedSim: deps.core.machine.sleepStartedSim,
    snoozeCount: deps.core.machine.snoozeCount,
    vars: snap.vars,
    statePulse: deps.state.pulseView(),
    activityLastSeq: deps.core.activityLastSeq(),
  };
}

/** 把 Express 连接挂到 hub 上;返回清理函数 */
export function attachSse(
  req: express.Request,
  res: express.Response,
  hub: LiveHub,
  log: (msg: string) => void,
): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const write = (chunk: string) => {
    if (res.writableEnded) return;
    res.write(chunk);
  };

  write(`event: ready\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);

  const detach = hub.add({
    send(event) {
      write(`event: live\ndata: ${JSON.stringify(event)}\n\n`);
    },
  });

  // 心跳只用于让客户端确认连接仍活着,不触发任何数据更新
  const heartbeat = setInterval(() => write(`: heartbeat ${Date.now()}\n\n`), 15_000);
  heartbeat.unref?.();
  log(`[live] SSE 已连接(当前 ${hub.subscribers} 个)`);

  const cleanup = () => {
    clearInterval(heartbeat);
    detach();
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
}

/**
 * 变更去重 + 节流:同一 topic 在窗口内最多推一次,
 * 且内容与上次相同就不推(避免「没变也刷新」)。
 */
export class Coalescer {
  private last = new Map<string, { at: number; hash: string }>();

  constructor(
    private readonly publish: (topic: string, data?: unknown) => void,
    private readonly windowMs = 1000,
  ) {}

  push(
    topic: string,
    data?: unknown,
    opts?: { immediate?: boolean; hash?: string; windowMs?: number },
  ): void {
    const now = Date.now();
    // 纯信号(data === undefined)没有内容可比,只按窗口去重
    const signal = data === undefined;
    const hash = opts?.hash ?? stableHash(data ?? topic);
    const prev = this.last.get(topic);
    if (!opts?.immediate && !signal && prev && prev.hash === hash) return;
    const window = opts?.windowMs ?? this.windowMs;
    if (!opts?.immediate && prev && now - prev.at < window) return;
    this.last.set(topic, { at: now, hash });
    this.publish(topic, data);
  }

  invalidate(topic: string): void {
    this.last.delete(topic);
  }
}

function stableHash(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}
