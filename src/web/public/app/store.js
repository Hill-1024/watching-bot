import { reactive } from "/vendor/vue.esm-browser.prod.js";
import { api, AuthError, clearToken, getToken, setToken, postJSON } from "./api.js";
import { onLive, publishLive, startLive, stopLive } from "./live.js";

/**
 * 全局状态:只放「壳层 + 跨页面共享」的东西。
 *
 * 更新模型是事件驱动的:
 * - 服务端在状态/日志/注入/插件变化时推 topic;
 * - 只有订阅了该 topic 的页面才会拉取与重渲染;
 * - 没有任何 setInterval 轮询接口。
 *
 * 页面自己的数据尽量留在页面内(见各页 setup),避免 A 页面被 B 的数据变化带着重绘。
 */
export const store = reactive({
  auth: { checked: false, ok: false, error: "" },
  live: { connected: false, error: "", authFailed: false, lastEventAt: 0 },
  status: null,
  statusAt: 0,
  statusError: "",
  legacyBackend: false,
  activity: [],
  activitySeq: 0,
  activityLive: false,
  activityStreaming: null,
  activityError: "",
  injections: [],
  injectionLastId: 0,
  injectionsLive: false,
  injectionError: "",
  toasts: [],
  theme: "dark",
});

try {
  store.theme = localStorage.getItem("wb_theme") || "dark";
} catch {
  store.theme = "dark";
}

export function applyTheme() {
  document.documentElement.dataset.theme = store.theme;
  try {
    localStorage.setItem("wb_theme", store.theme);
  } catch {
    // ignore
  }
}

export function toggleTheme() {
  store.theme = store.theme === "dark" ? "light" : "dark";
  applyTheme();
}

let toastSeq = 0;
export function notify(kind, text, ms = 3600) {
  const id = ++toastSeq;
  store.toasts.push({ id, kind, text });
  setTimeout(() => dismissToast(id), ms);
}

export function dismissToast(id) {
  const i = store.toasts.findIndex((t) => t.id === id);
  if (i >= 0) store.toasts.splice(i, 1);
}

const busy = { status: false, activity: false, injections: false };

/** 拉一次完整状态(首屏 / 重连补齐 / 手动刷新) */
export async function fetchStatus() {
  if (busy.status) return store.auth.ok;
  busy.status = true;
  try {
    const s = await api("/api/status");
    // 首屏/重连补齐:逐字段合并,已有字段内容相同就不动,避免整页闪一下
    if (!store.status) {
      store.status = s;
    } else {
      const cur = store.status;
      for (const [key, value] of Object.entries(s)) {
        if (key === "vars" && value && typeof value === "object") {
          if (!cur.vars) cur.vars = {};
          for (const [name, n] of Object.entries(value)) if (cur.vars[name] !== n) cur.vars[name] = n;
        } else if (JSON.stringify(cur[key]) !== JSON.stringify(value)) {
          cur[key] = value;
        }
      }
    }
    store.legacyBackend = !s.defs || !Array.isArray(s.plugins);
    store.statusAt = Date.now();
    store.statusError = "";
    store.auth = { checked: true, ok: true, error: "" };
    return true;
  } catch (err) {
    if (err instanceof AuthError) {
      store.auth = { checked: true, ok: false, error: "" };
      stopLiveFeed();
      return false;
    }
    store.statusError = err.message || "连接中断";
    if (!store.auth.ok) {
      store.auth = { checked: true, ok: false, error: store.statusError };
    }
    return store.auth.ok;
  } finally {
    busy.status = false;
  }
}

/** SSE 推送的状态是增量:逐字段合并,避免替换整个对象导致所有读 store.status 的组件重渲染 */
function applyStatus(data) {
  if (!data || typeof data !== "object") return;
  if (!store.status) {
    store.status = { ...data };
  } else {
    const s = store.status;
    for (const [key, value] of Object.entries(data)) {
      if (key === "vars" && value && typeof value === "object") {
        // 逐变量合并:只有真的变了的数字才会触发对应组件更新
        if (!s.vars) s.vars = {};
        for (const [name, n] of Object.entries(value)) {
          if (s.vars[name] !== n) s.vars[name] = n;
        }
      } else if (key === "statePulse") {
        s.statePulse = value;
      } else if (s[key] !== value) {
        s[key] = value;
      }
    }
  }
  store.statusAt = Date.now();
  store.statusError = "";
  if (!store.auth.ok) store.auth = { checked: true, ok: true, error: "" };
}

function applyPlugins(data) {
  if (!data || !store.status) return;
  if (Array.isArray(data.plugins) && JSON.stringify(data.plugins) !== JSON.stringify(store.status.plugins)) {
    store.status.plugins = data.plugins;
  }
  if (Array.isArray(data.modules) && JSON.stringify(data.modules) !== JSON.stringify(store.status.modules)) {
    store.status.modules = data.modules;
  }
}

function appendActivity(entries) {
  if (!entries?.length) return;
  store.activity.push(...entries);
  const overflow = store.activity.length - 700;
  if (overflow > 0) store.activity.splice(0, overflow);
}

export async function fetchActivity() {
  if (busy.activity || !store.activityLive) return;
  busy.activity = true;
  try {
    let after = store.activitySeq;
    let data = await api(`/api/activity?after=${after}`);
    if (data.reset) {
      store.activity = [];
      store.activitySeq = 0;
      data = await api("/api/activity?after=0");
    }
    appendActivity(data.entries);
    store.activitySeq = Number.isFinite(data.lastSeq) ? data.lastSeq : store.activitySeq;
    store.activityError = "";
  } catch (err) {
    if (err instanceof AuthError) {
      store.auth = { checked: true, ok: false, error: "" };
      stopLiveFeed();
    } else {
      store.activityError = err.message || "活动日志拉取失败";
    }
  } finally {
    busy.activity = false;
  }
}

function sortInjections(items) {
  return [...items].sort((a, b) => a.id - b.id);
}

function appendInjections(items) {
  if (!items?.length) return;
  const known = new Set(store.injections.map((i) => i.id));
  const fresh = sortInjections(items.filter((i) => !known.has(i.id)));
  if (!fresh.length) return;
  store.injections.push(...fresh);
  store.injectionLastId = Math.max(store.injectionLastId, fresh[fresh.length - 1].id);
  const overflow = store.injections.length - 400;
  if (overflow > 0) store.injections.splice(0, overflow);
}

export async function fetchInjections() {
  if (busy.injections || !store.injectionsLive) return;
  busy.injections = true;
  try {
    if (!store.injectionLastId) {
      const r = await api("/api/injections?page=1&pageSize=80");
      store.injections = sortInjections(r.items || []);
      store.injectionLastId = store.injections.at(-1)?.id ?? 0;
    } else {
      const r = await api(`/api/injections?afterId=${store.injectionLastId}&limit=200`);
      appendInjections(r.items || []);
    }
    store.injectionError = "";
  } catch (err) {
    if (err instanceof AuthError) {
      store.auth = { checked: true, ok: false, error: "" };
      stopLiveFeed();
    } else {
      store.injectionError = err.message || "注入流水拉取失败";
    }
  } finally {
    busy.injections = false;
  }
}

/** 只有活动日志页挂载时才会被事件驱动拉取 */
export function setActivityLive(live) {
  store.activityLive = Boolean(live);
  if (live) {
    store.activitySeq = 0;
    store.activity = [];
    void fetchActivity();
  }
}

/** 只有注入页挂载时才会被事件驱动拉取 */
export function setInjectionsLive(live) {
  store.injectionsLive = Boolean(live);
  if (live) {
    store.injectionLastId = 0;
    store.injections = [];
    void fetchInjections();
  }
}

let feedStarted = false;
let unsubscribers = [];

export function startLiveFeed() {
  if (feedStarted) return;
  feedStarted = true;
  unsubscribers = [
    onLive("status", applyStatus),
    onLive("plugins", applyPlugins),
    onLive("activity", () => {
      if (store.activityLive) void fetchActivity();
    }),
    onLive("activity:delta", (d) => {
      store.activityStreaming = d && typeof d === "object" ? d : null;
    }),
    onLive("injections", () => {
      if (store.injectionsLive) void fetchInjections();
    }),
    onLive("resync", () => {
      void fetchStatus();
      if (store.activityLive) void fetchActivity();
      if (store.injectionsLive) void fetchInjections();
    }),
  ];
  startLive({
    onState: (patch) => {
      Object.assign(store.live, patch);
      if (patch.connected) store.statusError = "";
    },
  });
  document.addEventListener("visibilitychange", onVisible);
}

export function stopLiveFeed() {
  if (!feedStarted) return;
  feedStarted = false;
  for (const off of unsubscribers.splice(0)) off();
  document.removeEventListener("visibilitychange", onVisible);
  stopLive();
  store.live = { connected: false, error: "", authFailed: false, lastEventAt: 0 };
}

function onVisible() {
  // 回到前台只需补齐一次;后台期间 SSE 通常仍保持连接
  if (document.hidden) return;
  publishLive("resync");
}

export async function bootstrap() {
  const ok = await fetchStatus();
  if (ok) startLiveFeed();
  return ok;
}

export async function login(token) {
  setToken(token.trim());
  const ok = await fetchStatus();
  if (!ok) {
    setToken("");
    store.auth = { checked: true, ok: false, error: "口令不正确,或后端未开启鉴权。" };
    stopLiveFeed();
    throw new Error("登录失败");
  }
  startLiveFeed();
}

export function logout() {
  setToken("");
  clearToken();
  stopLiveFeed();
  store.auth = { checked: true, ok: false, error: "" };
  store.status = null;
  store.statusAt = 0;
  store.activity = [];
  store.activitySeq = 0;
  store.injections = [];
  store.injectionLastId = 0;
}

/** 面板改状态值:乐观更新 store,返回服务端实际采用值 */
export async function setVar(name, value) {
  const r = await postJSON("/api/vars", { name, value });
  if (store.status) {
    store.status.vars = { ...store.status.vars, ...(r.vars || {}) };
  }
  return r;
}

export { getToken };
