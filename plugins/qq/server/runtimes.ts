import { readNapcatWebuiInfo } from "./napcat-webui.js";

/**
 * QQ 的 1-of-2 runtime 描述。
 *
 * NapCat 与 SnowLuma 都作为独立进程跑在本机,共用同一个 OneBot v11 适配器、同一套工具、
 * 同一个消息库与表情包目录。这里只描述连接地址、WebUI 入口和登录提示,不负责启动进程。
 */

export type RuntimeId = "napcat" | "snowluma";

export interface RuntimeDescriptor {
  id: RuntimeId;
  displayName: string;
  /** OneBot v11 正向 WebSocket 端口 */
  oneBotPort: number;
  webui: { defaultPort: number; label: string };
  remoteDesktop?: { defaultPort: number; label: string };
  securityNotes: string[];
}

export const RUNTIMES: Record<RuntimeId, RuntimeDescriptor> = {
  napcat: {
    id: "napcat",
    displayName: "NapCat",
    oneBotPort: 3001,
    webui: { defaultPort: 6099, label: "WebUI" },
    securityNotes: ["WebUI 与 OneBot 都只监听 127.0.0.1,不要暴露到公网"],
  },
  snowluma: {
    id: "snowluma",
    displayName: "SnowLuma",
    oneBotPort: 3001,
    webui: { defaultPort: 5099, label: "WebUI" },
    remoteDesktop: { defaultPort: 6081, label: "noVNC 远程桌面(扫码)" },
    securityNotes: ["WebUI / noVNC / OneBot 都只监听本机,不要暴露到公网"],
  },
};

export const RUNTIME_IDS: RuntimeId[] = ["napcat", "snowluma"];

export function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "napcat" || value === "snowluma";
}

export interface QqRuntimeConfig {
  /** 选中哪个 runtime 提供 QQ 接入 */
  runtime?: RuntimeId;
  /** 默认 OneBot 地址(未单独配置 napcatUrl/snowlumaUrl 时使用) */
  url?: string;
  napcatUrl?: string;
  snowlumaUrl?: string;
  token?: string;
  napcatToken?: string;
  snowlumaToken?: string;
  selfId?: number;
  dbPath?: string;
  memeDir?: string;
  sendMinIntervalMs?: number;
  sendJitterMs?: number;
  /** WebUI 端口覆盖(展示用;进程本身由用户/系统启动) */
  hostPorts?: Partial<Record<RuntimeId, number>>;
}

/** runtime 的 OneBot 端点:显式配置优先,否则统一的本地地址 */
export function oneBotUrl(id: RuntimeId, cfg: QqRuntimeConfig): string {
  const explicit = id === "napcat" ? cfg.napcatUrl : cfg.snowlumaUrl;
  if (explicit) return explicit;
  return cfg.url ?? "ws://127.0.0.1:3001";
}

export function oneBotToken(id: RuntimeId, cfg: QqRuntimeConfig): string {
  const explicit = id === "napcat" ? cfg.napcatToken : cfg.snowlumaToken;
  return explicit || cfg.token || "";
}

export interface LoginEntry {
  label: string;
  value?: string;
  sensitive: boolean;
  available: boolean;
  hint?: string;
}

export interface LoginInfo {
  runtime: RuntimeId;
  displayName: string;
  webuiUrl?: string;
  remoteDesktopUrl?: string;
  entries: LoginEntry[];
  instructions: string[];
}

/**
 * 登录信息是「展示抽象」,不要求两套 runtime 的认证方式一致:
 * 页面只消费 entries/instructions,不关心 token 来自 webui.json 还是手工配置。
 */
export function loginInfoOf(id: RuntimeId, cfg: QqRuntimeConfig): LoginInfo {
  const runtime = RUNTIMES[id];

  if (id === "napcat") {
    const webui = readNapcatWebuiInfo();
    const port = cfg.hostPorts?.napcat ?? (webui.port || runtime.webui.defaultPort);
    const token = oneBotToken(id, cfg);
    return {
      runtime: id,
      displayName: runtime.displayName,
      webuiUrl: `http://127.0.0.1:${port}`,
      entries: [
        {
          label: "WebUI Token",
          value: webui.token || token || undefined,
          sensitive: true,
          available: Boolean(webui.token || token),
          hint: webui.token
            ? webui.source === "env"
              ? "来自 NAPCAT_WEBUI_TOKEN"
              : "来自 NapCat 的 webui.json"
            : "尚未读取到 token:在 NapCat WebUI 配置里填写 NAPCAT_WEBUI_CONFIG 指向的 webui.json",
        },
        {
          label: "OneBot Token",
          value: token || undefined,
          sensitive: true,
          available: Boolean(token),
          hint: "OneBot WS 使用该 token;留空表示不校验",
        },
      ],
      instructions: [
        "启动 NapCat.Shell(launcher.bat / launcher.sh),用 QQ 扫码登录",
        "在 NapCat WebUI → 网络配置里启用 OneBot v11 WebSocket 服务器,端口 3001",
        "回到本页点「重连 OneBot」",
      ],
    };
  }

  const token = oneBotToken(id, cfg);
  const port = cfg.hostPorts?.snowluma ?? runtime.webui.defaultPort;
  const vncPort = runtime.remoteDesktop?.defaultPort;
  return {
    runtime: id,
    displayName: runtime.displayName,
    webuiUrl: `http://127.0.0.1:${port}`,
    remoteDesktopUrl: vncPort ? `http://127.0.0.1:${vncPort}` : undefined,
    entries: [
      {
        label: "OneBot Token",
        value: token || undefined,
        sensitive: true,
        available: Boolean(token),
        hint: token ? "面板配置的 token" : "OneBot WS 使用该 token;留空表示不校验",
      },
      {
        label: "WebUI 账号 / 密码",
        sensitive: true,
        available: false,
        hint: "请查看 SnowLuma 自己的 WebUI 配置或其启动日志",
      },
      {
        label: "noVNC 密码",
        sensitive: true,
        available: false,
        hint: "请查看 SnowLuma 的 vnc-password 配置",
      },
    ],
    instructions: [
      "启动 SnowLuma 进程,在 WebUI / noVNC 里用 QQ 扫码登录",
      "确认 OneBot v11 WebSocket 服务器监听 3001",
      "回到本页点「重连 OneBot」",
    ],
  };
}
