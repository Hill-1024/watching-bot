import { getToken } from "./api.js";

/**
 * 事件驱动的实时通道。
 *
 * 为什么不是 EventSource:浏览器原生 EventSource 不能带 Authorization 头,
 * 只能把长期口令放进 URL。这里用 fetch + ReadableStream 自己读 SSE,鉴权头照常带上。
 *
 * 页面隔离:每个页面只订阅自己关心的 topic;别的模块变了不会触发本页任何更新。
 * 服务端只在真的有变化时推一条,不做固定频率轮询。
 */

const listeners = new Map();
let controller = null;
let reconnectTimer = null;
let backoff = 1000;
let stopped = true;

export function onLive(topic, fn) {
  const set = listeners.get(topic) ?? new Set();
  set.add(fn);
  listeners.set(topic, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) listeners.delete(topic);
  };
}

/** 本地广播(乐观更新 / 重连补齐),与远端 topic 同一套订阅 */
export function publishLive(topic, data) {
  for (const fn of [...(listeners.get(topic) ?? [])]) {
    try {
      fn(data);
    } catch (err) {
      console.error(`[live] ${topic} 订阅者异常`, err);
    }
  }
}

export function startLive({ onState } = {}) {
  if (!stopped) return;
  stopped = false;
  void loop(onState);
}

export function stopLive() {
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  controller?.abort();
  controller = null;
}

async function loop(onState) {
  if (stopped) return;
  controller = new AbortController();
  try {
    const headers = { Accept: "text/event-stream" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch("/api/events", { headers, signal: controller.signal, cache: "no-store" });
    if (res.status === 401) {
      onState?.({ connected: false, authFailed: true, error: "登录已失效" });
      stopped = true;
      return;
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    backoff = 1000;
    onState?.({ connected: true, authFailed: false, error: "", lastEventAt: Date.now() });
    // 重连后补齐可能错过的变化(服务端不缓存历史事件)
    publishLive("resync");
    await readStream(res.body, onState);
  } catch (err) {
    if (stopped) return;
    onState?.({ connected: false, error: err?.message || "连接中断" });
  }
  if (stopped) return;
  reconnectTimer = setTimeout(() => void loop(onState), backoff);
  backoff = Math.min(backoff * 2, 15_000);
}

async function readStream(body, onState) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!stopped) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let split;
    while ((split = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      handleFrame(frame, onState);
    }
  }
}

function handleFrame(frame, onState) {
  if (!frame) return;
  if (frame.startsWith(":")) {
    onState?.({ lastEventAt: Date.now() });
    return;
  }
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  if (!data) return;
  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }
  if (!event?.topic) return;
  onState?.({ lastEventAt: Date.now() });
  publishLive(event.topic, event.data);
}
