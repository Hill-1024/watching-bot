import { reactive } from "/vendor/vue.esm-browser.prod.js";
import { api, AuthError, clearToken, getToken, setToken, postJSON } from "./api.js";

export const store = reactive({
  auth: { checked: false, ok: false, error: "" },
  status: null,
  statusAt: 0,
  statusError: "",
  legacyBackend: false,
  activity: [],
  activitySeq: 0,
  activityLive: true,
  activityError: "",
  injections: [],
  injectionLastId: 0,
  injectionsLive: true,
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

let pollStarted = false;
const busy = { status: false, activity: false, injections: false };
let timers = [];

/** 状态轮询:只写 store,不碰任何表单草稿 */
export async function fetchStatus() {
  if (busy.status) return store.auth.ok;
  busy.status = true;
  try {
    const s = await api("/api/status");
    store.status = s;
    store.legacyBackend = !s.defs || !Array.isArray(s.knownModules);
    store.statusAt = Date.now();
    store.statusError = "";
    store.auth = { checked: true, ok: true, error: "" };
    return true;
  } catch (err) {
    if (err instanceof AuthError) {
      store.auth = { checked: true, ok: false, error: "" };
      stopPolling();
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
      stopPolling();
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
      stopPolling();
    } else {
      store.injectionError = err.message || "注入流水拉取失败";
    }
  } finally {
    busy.injections = false;
  }
}

export function setActivityLive(live) {
  store.activityLive = live;
  if (live) {
    store.activitySeq = 0;
    store.activity = [];
    void fetchActivity();
  }
}

export function setInjectionsLive(live) {
  store.injectionsLive = live;
  if (live) {
    store.injectionLastId = 0;
    store.injections = [];
    void fetchInjections();
  }
}

const onVisibility = () => {
  if (document.hidden) return;
  void fetchStatus();
  if (store.activityLive) void fetchActivity();
  if (store.injectionsLive) void fetchInjections();
};

export function startPolling() {
  if (pollStarted) return;
  pollStarted = true;
  document.addEventListener("visibilitychange", onVisibility);
  void fetchStatus();
  if (store.activityLive) void fetchActivity();
  if (store.injectionsLive) void fetchInjections();
  timers = [
    setInterval(() => {
      if (!document.hidden) void fetchStatus();
    }, 2000),
    setInterval(() => {
      if (!document.hidden) void fetchActivity();
    }, 2000),
    setInterval(() => {
      if (!document.hidden) void fetchInjections();
    }, 3000),
  ];
}

export function stopPolling() {
  if (!pollStarted) return;
  pollStarted = false;
  document.removeEventListener("visibilitychange", onVisibility);
  for (const t of timers) clearInterval(t);
  timers = [];
}

export async function bootstrap() {
  if (!store.auth.checked) store.auth.checked = true;
  const ok = await fetchStatus();
  if (ok) startPolling();
  return ok;
}

export async function login(token) {
  setToken(token.trim());
  const ok = await fetchStatus();
  if (!ok) {
    setToken("");
    store.auth = { checked: true, ok: false, error: "口令不正确,或后端未开启鉴权。" };
    throw new Error("登录失败");
  }
  startPolling();
}

export function logout() {
  setToken("");
  clearToken();
  stopPolling();
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
