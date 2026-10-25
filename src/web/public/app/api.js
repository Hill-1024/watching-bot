const TOKEN_KEY = "wb_token";

export class ApiError extends Error {
  constructor(status, message, data = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

export class AuthError extends ApiError {
  constructor(message = "需要登录") {
    super(401, message);
    this.name = "AuthError";
  }
}

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // 隐私模式下 localStorage 可能不可用,退化为本次会话内有效
  }
}

export function clearToken() {
  setToken("");
}

/** 切到 ?token= 时捕获并清洗地址栏,避免口令留在历史记录里 */
export function captureUrlToken() {
  const params = new URLSearchParams(location.search);
  if (!params.has("token")) return;
  setToken(params.get("token"));
  params.delete("token");
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : "") + location.hash);
}

export async function api(path, opts = {}) {
  const headers = { Accept: "application/json", ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { ...opts, headers });
  } catch (err) {
    throw new ApiError(0, "无法连接后端,请确认 watching-bot 正在运行");
  }
  if (res.status === 401) throw new AuthError();
  let data = {};
  try {
    data = await res.json();
  } catch {
    // 非 JSON 响应(静态文件错误等)按空对象处理
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `请求失败 (HTTP ${res.status})`, data);
  return data;
}

export const getJSON = (path) => api(path);
export const postJSON = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });

export function query(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
