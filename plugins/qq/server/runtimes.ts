import { readNapcatWebuiInfo } from "./napcat-webui.js";

/**
 * QQ 的 1-of-2 runtime 描述。
 *
 * 差异只允许出现在这里:NapCat 与 SnowLuma 使用同一个 OneBot v11 适配器、同一套工具、
 * 同一个消息库与表情包目录。切换 runtime 只换「进程/登录入口/容器规格」,不换能力。
 */

export type RuntimeId = "napcat" | "snowluma";

export interface RuntimeDescriptor {
  id: RuntimeId;
  displayName: string;
  /** 固定镜像,不接受用户输入 */
  image: string;
  containerName: string;
  /** 容器内 OneBot WS 端口(不发布到宿主) */
  onebotPort: number;
  webui: { containerPort: number; defaultHostPort: number; label: string };
  extraUIs: { kind: "novnc"; containerPort: number; defaultHostPort: number; label: string }[];
  /** 安装确认页必须展示的权限/资源说明 */
  securityNotes: string[];
  /** 宿主侧 WebUI 默认地址 */
  defaultWebuiUrl: string;
}

export const RUNTIMES: Record<RuntimeId, RuntimeDescriptor> = {
  napcat: {
    id: "napcat",
    displayName: "NapCat",
    image: "mlikiowa/napcat-docker:latest",
    containerName: "watching-qq-napcat",
    onebotPort: 3001,
    webui: { containerPort: 6099, defaultHostPort: 6099, label: "WebUI" },
    extraUIs: [],
    securityNotes: ["WebUI 需要登录 token", "仅监听 127.0.0.1,不要暴露到公网"],
    defaultWebuiUrl: "http://127.0.0.1:6099",
  },
  snowluma: {
    id: "snowluma",
    displayName: "SnowLuma",
    image: "motricseven7/snowluma:latest",
    containerName: "watching-qq-snowluma",
    onebotPort: 3001,
    webui: { containerPort: 5099, defaultHostPort: 5099, label: "WebUI" },
    extraUIs: [{ kind: "novnc", containerPort: 6081, defaultHostPort: 6081, label: "noVNC 远程桌面(扫码)" }],
    securityNotes: [
      "容器需要 SYS_PTRACE 与 seccomp=unconfined(官方部署要求)",
      "noVNC/WebUI 初始口令可能只出现在首次日志里",
      "仅监听 127.0.0.1,不要暴露到公网",
    ],
    defaultWebuiUrl: "http://127.0.0.1:5099",
  },
};

export const RUNTIME_IDS: RuntimeId[] = ["napcat", "snowluma"];

export function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "napcat" || value === "snowluma";
}

export interface QqRuntimeConfig {
  /** 选中哪个 runtime 提供 QQ 接入 */
  runtime?: RuntimeId;
  /** 本地直连模式下的 OneBot 地址(不经过 supervisor) */
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
  /** supervisor 内网地址;为空表示本地直连 */
  supervisorUrl?: string;
  /** 宿主侧 WebUI 端口覆盖 */
  hostPorts?: Partial<Record<RuntimeId, number>>;
}

/** runtime 的 OneBot 端点:优先显式配置,其次 supervisor 内网别名 */
export function oneBotUrl(id: RuntimeId, cfg: QqRuntimeConfig): string {
  const explicit = id === "napcat" ? cfg.napcatUrl : cfg.snowlumaUrl;
  if (explicit) return explicit;
  if (cfg.supervisorUrl) return `ws://${id}:${RUNTIMES[id].onebotPort}`;
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

export interface SnowlumaInitialCredentials {
  webuiUser?: string;
  webuiPassword?: string;
  vncPassword?: string;
  /** 从 runtime 自身配置读到的 OneBot token(自动抓取) */
  onebotToken?: string;
  /** 该 token 的来源说明,给面板展示 */
  onebotTokenSource?: string;
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
 * 页面只消费 entries/instructions,不关心 token 来自 webui.json 还是首次日志。
 */
export function loginInfoOf(
  id: RuntimeId,
  cfg: QqRuntimeConfig,
  initial?: SnowlumaInitialCredentials,
): LoginInfo {
  const port = cfg.hostPorts?.[id] ?? RUNTIMES[id].webui.defaultHostPort;
  const webuiUrl = `http://127.0.0.1:${port}`;

  if (id === "napcat") {
    const webui = readNapcatWebuiInfo();
    return {
      runtime: id,
      displayName: RUNTIMES[id].displayName,
      webuiUrl,
      entries: [
        {
          label: "WebUI Token",
          value: webui.token || oneBotToken(id, cfg) || undefined,
          sensitive: true,
          available: Boolean(webui.token || oneBotToken(id, cfg)),
          hint: webui.token
            ? webui.source === "env"
              ? "来自 NAPCAT_WEBUI_TOKEN"
              : "来自 NapCat webui.json"
            : "尚未读取到 token:启动 NapCat 后查看首次日志或配置 NAPCAT_WEBUI_TOKEN",
        },
        {
          label: "OneBot Token",
          value: oneBotToken(id, cfg) || undefined,
          sensitive: true,
          available: Boolean(oneBotToken(id, cfg)),
          hint: "OneBot WS 使用该 token;留空表示不校验",
        },
      ],
      instructions: [
        "打开 WebUI,用 QQ 扫码登录",
        "确认 OneBot v11 反向/正向 WS 已启用,端口 3001",
        "登录成功后回到本页点「重连」",
      ],
    };
  }

  const novnc = RUNTIMES[id].extraUIs[0]!;
  const token = oneBotToken(id, cfg);
  return {
    runtime: id,
    displayName: RUNTIMES[id].displayName,
    webuiUrl,
    remoteDesktopUrl: `http://127.0.0.1:${cfg.hostPorts?.snowluma ?? novnc.defaultHostPort}`,
    entries: [
      {
        label: "OneBot Token",
        value: initial?.onebotToken || token || undefined,
        sensitive: true,
        available: Boolean(initial?.onebotToken || token),
        hint: initial?.onebotToken
          ? initial.onebotTokenSource ?? "已自动读取"
          : initial?.onebotTokenSource ?? "OneBot WS 使用该 token;留空表示不校验",
      },
      {
        label: "WebUI 初始账号",
        value: initial?.webuiUser,
        sensitive: false,
        available: Boolean(initial?.webuiUser),
        hint: initial?.webuiUser ? undefined : "尚未从容器首次启动日志中解析到(日志轮转后不可恢复,可重建容器重新生成)",
      },
      {
        label: "WebUI 初始密码",
        value: initial?.webuiPassword,
        sensitive: true,
        available: Boolean(initial?.webuiPassword),
        hint: initial?.webuiPassword
          ? "仅首次登录有效;若已在 WebUI 改过密码,以改后的为准"
          : "初始密码只在容器首次启动日志里出现一次;尚未解析到(可重建容器重新生成)",
      },
      {
        label: "noVNC 密码",
        value: initial?.vncPassword,
        sensitive: true,
        available: Boolean(initial?.vncPassword),
        hint: initial?.vncPassword
          ? "直接读自数据卷 /app/data/config/vnc-password(权威值,随卷持久化)"
          : "未能从数据卷读取,且日志候选未通过真实认证握手;可进容器执行 x11vnc -storepasswd 重设",
      },
    ],
    instructions: [
      "打开 noVNC 或 WebUI,用 QQ 扫码登录",
      "确认 OneBot v11 WS 监听 3001",
      "登录成功后回到本页点「重连」",
    ],
  };
}
