import WebSocket from "ws";

/**
 * OneBot 11 正向 WebSocket 客户端(对接 NapCat)。
 * - 动作调用:send JSON {action, params, echo},按 echo 等待响应
 * - 事件推送:message / notice / meta_event 回调
 * - 断线自动重连(指数退避,封顶 30s)
 */
export class OneBotClient {
  private ws: WebSocket | null = null;
  private echoSeq = 0;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 1000;
  private closedByUs = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: {
      onEvent: (event: Record<string, unknown>) => void;
      onOpen?: () => void;
      onClose?: () => void;
      log: (msg: string) => void;
    },
  ) {}

  connect(): void {
    this.closedByUs = false;
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const ws = new WebSocket(this.url, { headers });
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = 1000;
      this.handlers.log(`已连接 ${this.url}`);
      this.handlers.onOpen?.();
    });
    ws.on("message", (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof msg.echo === "string") {
        const p = this.pending.get(msg.echo);
        if (p) {
          this.pending.delete(msg.echo);
          if (msg.status === "failed" || (typeof msg.retcode === "number" && msg.retcode !== 0)) {
            p.reject(new Error(`OneBot 动作失败: ${JSON.stringify(msg).slice(0, 300)}`));
          } else {
            p.resolve(msg.data);
          }
        }
        return;
      }
      if (typeof msg.post_type === "string") {
        this.handlers.onEvent(msg);
      }
    });
    ws.on("error", (err) => this.handlers.log(`WS 错误: ${err.message}`));
    ws.on("close", () => {
      this.ws = null;
      this.handlers.onClose?.();
      if (this.closedByUs) return;
      this.handlers.log(`连接断开,${this.backoffMs}ms 后重连`);
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 调用 OneBot 动作 */
  call(action: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error("OneBot WS 未连接"));
    const echo = `wb-${++this.echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 动作超时: ${action}`));
      }, timeoutMs);
      this.pending.set(echo, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws!.send(JSON.stringify({ action, params, echo }));
    });
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

// ---------- OneBot 11 消息模型(本模块用到的最小子集) ----------

export interface ObSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface ObMessageEvent {
  post_type: "message";
  message_type: "private" | "group";
  sub_type?: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  time: number;
  message: string | ObSegment[];
  raw_message?: string;
  sender?: { user_id?: number; nickname?: string; card?: string };
}

export interface ObFriend {
  user_id: number;
  nickname: string;
  remark?: string;
}

export interface ObGroup {
  group_id: number;
  group_name: string;
  member_count?: number;
}

/** 把消息段数组/字符串压成可读文本 */
export function flattenMessage(message: string | ObSegment[]): string {
  if (typeof message === "string") return message;
  return message
    .map((seg) => {
      switch (seg.type) {
        case "text":
          return String(seg.data.text ?? "");
        case "at":
          return seg.data.qq === "all" ? "@全体成员" : `@${seg.data.qq}`;
        case "image":
        case "record":
        case "video":
          return `[${seg.type}]`;
        case "face":
          return `[表情]`;
        case "reply":
          return `[回复]`;
        case "forward":
          return `[合并转发]`;
        case "json":
          return `[卡片]`;
        default:
          return `[${seg.type}]`;
      }
    })
    .join("")
    .trim();
}
