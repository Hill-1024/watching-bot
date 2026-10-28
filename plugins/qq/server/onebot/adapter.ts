import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { PerceptionEvent } from "../../../../src/bus/types.js";
import { OneBotClient, type ObFriend, type ObGroup, type ObMessageEvent, type ObSegment } from "./client.js";
import { NapcatStore } from "./store.js";

export interface OneBotSettings {
  url?: string;
  token?: string;
  /** 自己的 QQ 号(用于识别被@);0 = 启动后用 get_login_info 自取 */
  selfId?: number;
  dbPath?: string;
  /** 表情包图片文件目录 */
  memeDir?: string;
  /** 发送节流:最小间隔与随机抖动(防风控) */
  sendMinIntervalMs?: number;
  sendJitterMs?: number;
}

/** 适配器只需要宿主两件事:上报感知、写日志。它不知道插件、状态或提示词。 */
export interface AdapterHost {
  emitPerception(e: PerceptionEvent): void;
  log(msg: string): void;
  /** 连接状态变化(面板据此推送,而不是轮询) */
  onConnectionChange?(): void;
}

/** 下载图片并转 base64(存表情包/多模态查看共用) */
async function fetchImage(url: string): Promise<{ b64: string; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get("content-type") ?? "image/png").split(";")[0]!;
  return { b64: buf.toString("base64"), mime };
}

const IMG_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const MAX_OUTGOING_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_OUTGOING_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 把模型给的图片来源变成 OneBot image segment 的 file 值。
 *
 * - http(s) URL:原样交给协议端下载;
 * - base64:// / data URL:转成 base64://;
 * - 其余按本地路径读成 base64://,这样即使 bot 与协议端不共享文件系统也能发。
 */
function imageFileValue(ref: string): string {
  const value = ref.trim();
  if (!value) throw new Error("图片地址/路径为空");
  if (value.startsWith("data:")) {
    const match = /^data:[^;]*;base64,(.*)$/s.exec(value);
    if (!match?.[1]) throw new Error("data URL 必须是 base64 编码");
    return `base64://${match[1]}`;
  }
  if (/^base64:\/\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;

  const abs = resolve(value);
  if (!existsSync(abs)) throw new Error(`图片文件不存在: ${value}`);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error(`不是文件: ${value}`);
  if (stat.size > MAX_OUTGOING_IMAGE_BYTES) {
    throw new Error(`图片太大(${stat.size} 字节 > ${MAX_OUTGOING_IMAGE_BYTES} 字节上限)`);
  }
  return `base64://${readFileSync(abs).toString("base64")}`;
}

/** 文件上传用:URL 原样传;本地路径必须是协议端能读到的真实路径 */
function fileUploadValue(ref: string): { file: string; name: string } {
  const value = ref.trim();
  if (!value) throw new Error("文件路径/地址为空");
  if (/^https?:\/\//i.test(value)) {
    let name = "file";
    try {
      name = decodeURIComponent(new URL(value).pathname.split("/").pop() || "file");
    } catch {
      // 名字取不到就用 file
    }
    return { file: value, name };
  }

  const abs = resolve(value);
  if (!existsSync(abs)) throw new Error(`文件不存在: ${value}`);
  const stat = statSync(abs);
  if (!stat.isFile()) throw new Error(`不是文件: ${value}`);
  if (stat.size > MAX_OUTGOING_FILE_BYTES) {
    throw new Error(`文件太大(${stat.size} 字节 > ${MAX_OUTGOING_FILE_BYTES} 字节上限)`);
  }
  return { file: abs, name: basename(abs) };
}

/** 发送节流:最小间隔 + 抖动,超限排队 */
class SendThrottle {
  private queue: (() => void)[] = [];
  private lastSent = 0;
  private draining = false;

  constructor(private readonly minMs: number, private readonly jitterMs: number) {}

  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const wait = this.lastSent + this.minMs + Math.random() * this.jitterMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastSent = Date.now();
      const next = this.queue.shift();
      next?.();
    }
    this.draining = false;
  }
}

/**
 * OneBot v11 适配器:NapCat 与 SnowLuma 共用这一份协议/工具/存储实现。
 *
 * 运行时差异(NapCat 还是 SnowLuma)只影响 WebUI 端口与登录入口,
 * 不影响这里的一行代码 —— 两套 runtime 暴露的都是同一套 OneBot 11 动作。
 * 对插件只暴露:黑箱工具(消息读写)+ 感知事件(message/mention)。
 */
export class OneBotAdapter {
  readonly toolTags: Record<string, string[]> = {
    send_message: ["social"],
    read_messages: ["social"],
    send_meme: ["social"],
  };
  tools: AgentTool<any>[] = [];

  private host: AdapterHost | null = null;
  private client: OneBotClient | null = null;
  private store: NapcatStore | null = null;
  private throttle: SendThrottle = new SendThrottle(2500, 1500);
  private selfId = 0;
  private memeDir = "data/modules/memes";

  async connect(cfg: OneBotSettings, host: AdapterHost): Promise<void> {
    this.host = host;
    const url = cfg.url ?? "ws://127.0.0.1:3001";
    this.selfId = cfg.selfId ?? 0;
    this.memeDir = cfg.memeDir ?? "data/modules/memes";
    this.store = new NapcatStore(cfg.dbPath ?? "data/modules/napcat.db");
    this.throttle = new SendThrottle(cfg.sendMinIntervalMs ?? 2500, cfg.sendJitterMs ?? 1500);
    if (!existsSync(this.memeDir)) mkdirSync(this.memeDir, { recursive: true });

    this.client = new OneBotClient(url, cfg.token ?? "", {
      onEvent: (e) => this.onEvent(e),
      onOpen: () => {
        host.onConnectionChange?.();
        void this.onReady()
          .catch((err) => {
            this.host?.log(`onReady 异常: ${String(err)}`);
          })
          .finally(() => host.onConnectionChange?.());
      },
      onClose: () => host.onConnectionChange?.(),
      log: (msg) => host.log(msg),
    });
    this.client.connect();
    this.buildTools();
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  get selfQq(): number {
    return this.selfId;
  }

  /** 轻量登录态探测:WS 通不代表 QQ 已登录,两者要分开呈现 */
  async loginInfo(): Promise<{ userId: number; nickname: string } | null> {
    if (!this.client?.connected) return null;
    try {
      const info = (await this.client.call("get_login_info")) as { user_id?: number; nickname?: string };
      if (!info?.user_id) return null;
      return { userId: info.user_id, nickname: info.nickname ?? "" };
    } catch {
      return null;
    }
  }

  private async onReady(): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      if (this.selfId === 0) {
        const info = (await this.client!.call("get_login_info")) as { user_id: number; nickname: string };
        this.selfId = info.user_id;
        host.log(`登录身份: ${info.nickname}(${info.user_id})`);
      }
      // 刚登录时协议端可能还在同步通讯录,首次加载给足时间,避免开机顺序把缓存留空
      const friends = (await this.client!.call("get_friend_list", {}, 60_000)) as unknown as ObFriend[];
      this.store?.cacheFriends(friends ?? []);
      const groups = (await this.client!.call("get_group_list", {}, 60_000)) as unknown as ObGroup[];
      this.store?.cacheGroups(groups ?? []);
      host.log(`通讯录就绪: ${friends?.length ?? 0} 好友, ${groups?.length ?? 0} 群`);
    } catch (err) {
      // 插件可能在校验中途被面板热切换停掉,此时 host 已置空
      if (this.host) host.log(`初始化失败(稍后重连会再试): ${String(err)}`);
    }
  }

  private onEvent(raw: Record<string, unknown>): void {
    if (!this.host) return;
    // 戳一戳(OneBot 通知事件,不是消息)。只响应当前 bot 在群里被戳:
    // 落到 @提及流并注入「有人戳了你一下」;模型可用 get_recent_at_mentions 看是谁,
    // 想回戳就调 poke_user。
    if (raw.post_type === "notice") {
      // OneBot 11 标准是 notify/poke;部分实现只发 notice_type=poke,两种都认
      const isPoke =
        (raw.notice_type === "notify" && raw.sub_type === "poke") || raw.notice_type === "poke";
      if (!isPoke) return;
      const target = Number(raw.target_id ?? raw.user_id);
      const senderId = Number(raw.user_id);
      const groupId = Number(raw.group_id ?? 0);
      // 群戳与私聊戳都要响应:私聊事件没有 group_id
      if (target !== this.selfId || !senderId) return;
      this.store?.insertPoke({
        user_id: senderId,
        target_id: target,
        group_id: groupId || undefined,
        time: Number(raw.time ?? Math.floor(Date.now() / 1000)),
      });
      const chatKey = groupId ? `group:${groupId}` : `private:${senderId}`;
      this.host.emitPerception({ kind: "mention", intensity: 1, source: chatKey });
      return;
    }
    if (raw.post_type !== "message") return;
    const e = raw as unknown as ObMessageEvent;
    const segments: ObSegment[] = Array.isArray(e.message)
      ? e.message
      : [{ type: "text", data: { text: e.message } }];
    const atMe = segments.some(
      (s) => s.type === "at" && (s.data.qq === "all" || String(s.data.qq) === String(this.selfId)),
    );
    this.store?.insertMessage(e, this.selfId, atMe);
    // 感知事件:被@ → mention;普通消息 → message。风暴聚合由核心负责。
    this.host.emitPerception({
      kind: atMe ? "mention" : "message",
      intensity: atMe ? 3 : 1,
      source: `${e.message_type}:${e.message_type === "group" ? e.group_id : e.user_id}`,
    });
  }

  private buildTools(): void {
    const store = () => {
      if (!this.store) throw new Error("QQ 模块未就绪");
      return this.store;
    };
    const client = () => {
      if (!this.client?.connected) throw new Error("QQ 连接断开中,稍后再试");
      return this.client;
    };

    const chatsParams = Type.Object({});
    const listChats: AgentTool<typeof chatsParams> = {
      name: "list_chats",
      label: "看会话列表",
      description: "看看最近有哪些会话,各自有多少未读消息。未读只会在你 mark_read 或 read_messages 之后减少。",
      parameters: chatsParams,
      execute: async () => {
        const chats = store().chatsWithUnread();
        const lines = chats.map(
          (c) =>
            `- [${c.chatKey}] ${c.title}${c.unread > 0 ? `(未读 ${c.unread})` : "(没有新消息)"} 最近:${c.lastMsgText}`,
        );
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "还没有任何消息。" }],
          details: { chats },
        };
      },
    };

    const readParams = Type.Object({
      chat: Type.String({ description: '会话标识,来自 list_chats,如 "group:123" 或 "private:456"' }),
      n: Type.Optional(Type.Number({ description: "读最近几条,默认 10,最多 30" })),
    });
    const readMessages: AgentTool<typeof readParams> = {
      name: "read_messages",
      label: "读消息",
      description:
        "读某个会话的最近消息,每条带消息 id(回复/贴表情/存图都靠它)。带 [图片] 的消息可以用 view_message_image 看、save_meme_from_message 收藏。读了不代表已读:想消掉未读还要 mark_read。",
      parameters: readParams,
      execute: async (_id, params: { chat: string; n?: number }) => {
        const n = Math.min(Math.max(params.n ?? 10, 1), 30);
        const msgs = store().readMessages(params.chat, n);
        const lines = msgs.map((m) => {
          const img = m.imageCount > 0 ? `[图片×${m.imageCount}]` : "";
          return `[${new Date(m.msgTime * 1000).toLocaleString("zh-CN")}] ${m.senderName}${m.atMe ? "(@你)" : ""}: ${m.text}${img} (id:${m.messageId})`;
        });
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "这个会话还没有消息。" }],
          details: { count: msgs.length, lastRowId: msgs.at(-1)?.rowId ?? 0 },
        };
      },
    };

    const sendParams = Type.Object({
      chat: Type.String({ description: '会话标识,如 "group:123" 或 "private:456"' }),
      text: Type.Optional(Type.String({ description: "文字内容;只想发图片/文件时可以省略" })),
      replyTo: Type.Optional(Type.Number({ description: "要引用回复的消息 id(可选)" })),
      images: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "要一起发送的图片,每项可以是 http(s) URL、base64://、data:image/... 或本地文件路径;最多 9 张",
          maxItems: 9,
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "要上传的文件,每项是本地文件路径或 http(s) URL(群文件/私聊文件);最多 5 个。文件由协议端读取,需与 bot 在同一台机器",
          maxItems: 5,
        }),
      ),
    });
    const sendMessage: AgentTool<typeof sendParams> = {
      name: "send_message",
      label: "发消息",
      description:
        "给某个会话发消息:文字、图片(images)和文件(files)可以一起发,可以带 replyTo 引用回复。chat 用 list_chats 里的标识:群聊 group:<群号>,私聊 private:<QQ号>——知道对方 QQ 就能主动私聊(群友、陌生人皆可,但非好友私聊可能受 QQ 风控限制)。图片支持 URL、base64 或本地路径;文件走上传接口,本地路径需要协议端也能读到。发送有节奏限制(防止刷屏),急不来。",
      parameters: sendParams,
      execute: async (
        _id,
        params: { chat: string; text?: string; replyTo?: number; images?: string[]; files?: string[] },
      ) => {
        const [type, idStr] = params.chat.split(":");
        const id = Number(idStr);
        if ((type !== "group" && type !== "private") || !Number.isFinite(id)) {
          throw new Error(`会话标识不合法: ${params.chat}`);
        }
        const text = params.text?.trim() ?? "";
        const imageRefs = params.images ?? [];
        const fileRefs = params.files ?? [];
        if (!text && imageRefs.length === 0 && fileRefs.length === 0) {
          throw new Error("text / images / files 至少要有一个");
        }

        // 先把本地图片读成 base64,避免发到一半才发现路径不对
        const imageValues = imageRefs.map(imageFileValue);
        const files = fileRefs.map(fileUploadValue);

        const segments: ObSegment[] = [];
        if (params.replyTo != null) segments.push({ type: "reply", data: { id: String(params.replyTo) } });
        if (text) segments.push({ type: "text", data: { text } });
        for (const file of imageValues) segments.push({ type: "image", data: { file } });

        let messageId: unknown = null;
        if (segments.length > 0) {
          await this.throttle.acquire();
          messageId = await client().call(
            type === "group" ? "send_group_msg" : "send_private_msg",
            type === "group" ? { group_id: id, message: segments } : { user_id: id, message: segments },
          );
        }

        const uploaded: string[] = [];
        for (const file of files) {
          await this.throttle.acquire();
          await client().call(
            type === "group" ? "upload_group_file" : "upload_private_file",
            type === "group" ? { group_id: id, file: file.file, name: file.name } : { user_id: id, file: file.file, name: file.name },
            120_000,
          );
          uploaded.push(file.name);
        }

        const parts: string[] = [];
        if (messageId != null) parts.push(params.replyTo != null ? "回复发出去了" : "消息发出去了");
        if (uploaded.length > 0) parts.push(`文件已上传: ${uploaded.join(", ")}`);
        return {
          content: [{ type: "text", text: `${parts.join(";")}。` }],
          details: { messageId, images: imageValues.length, files: uploaded },
        };
      },
    };

    // ---------- 群管理(需要 bot 是管理员/群主,权限不足时 OneBot 会报错) ----------

    const banParams = Type.Object({
      chat: Type.String({ description: '群会话标识,如 "group:123"' }),
      user: Type.Number({ description: "要禁言的成员 QQ 号" }),
      minutes: Type.Optional(Type.Number({ description: "禁言多少分钟,默认 10,0 = 解除禁言,最大 43200(30天)" })),
    });
    const setGroupBan: AgentTool<typeof banParams> = {
      name: "set_group_ban",
      label: "禁言",
      description:
        "作为群管理员禁言某个成员(或解除)。下手之前先用 get_group_member_info 确认对方身份,别惹了群主。",
      parameters: banParams,
      execute: async (_id, params: { chat: string; user: number; minutes?: number }) => {
        const groupId = Number(params.chat.split(":")[1]);
        if (!Number.isFinite(groupId)) throw new Error(`会话标识不合法: ${params.chat}`);
        const minutes = Math.min(Math.max(params.minutes ?? 10, 0), 43200);
        await client().call("set_group_ban", {
          group_id: groupId,
          user_id: params.user,
          duration: Math.round(minutes * 60),
        });
        return {
          content: [{ type: "text", text: minutes === 0 ? "已解除禁言。" : `已禁言 ${minutes} 分钟。` }],
          details: { groupId, userId: params.user, minutes },
        };
      },
    };

    const titleParams = Type.Object({
      chat: Type.String({ description: '群会话标识,如 "group:123"' }),
      user: Type.Number({ description: "成员 QQ 号" }),
      title: Type.String({ description: "定制头衔内容;空字符串 = 撤销头衔" }),
    });
    const setGroupSpecialTitle: AgentTool<typeof titleParams> = {
      name: "set_group_special_title",
      label: "发定制头衔",
      description: "作为群主给成员发专属头衔(定制称号)。空字符串撤销。",
      parameters: titleParams,
      execute: async (_id, params: { chat: string; user: number; title: string }) => {
        const groupId = Number(params.chat.split(":")[1]);
        if (!Number.isFinite(groupId)) throw new Error(`会话标识不合法: ${params.chat}`);
        await client().call("set_group_special_title", {
          group_id: groupId,
          user_id: params.user,
          special_title: params.title,
        });
        return {
          content: [{ type: "text", text: params.title ? `头衔「${params.title}」已戴上。` : "头衔已撤销。" }],
          details: { groupId, userId: params.user, title: params.title },
        };
      },
    };

    const memberInfoParams = Type.Object({
      chat: Type.String({ description: '群会话标识,如 "group:123"' }),
      user: Type.Number({ description: "成员 QQ 号" }),
    });
    const getGroupMemberInfo: AgentTool<typeof memberInfoParams> = {
      name: "get_group_member_info",
      label: "查群成员身份",
      description: "查某人在群里的身份(role: owner 群主 / admin 管理员 / member 普通成员)和群名片。",
      parameters: memberInfoParams,
      execute: async (_id, params: { chat: string; user: number }) => {
        const groupId = Number(params.chat.split(":")[1]);
        if (!Number.isFinite(groupId)) throw new Error(`会话标识不合法: ${params.chat}`);
        const info = (await client().call("get_group_member_info", {
          group_id: groupId,
          user_id: params.user,
        })) as { role?: string; card?: string; nickname?: string; title?: string };
        const roleName = { owner: "群主", admin: "管理员", member: "普通成员" }[info.role ?? "member"] ?? info.role;
        return {
          content: [
            {
              type: "text",
              text: `${info.card || info.nickname || params.user}: ${roleName}${info.title ? `,头衔「${info.title}」` : ""}。`,
            },
          ],
          details: info as unknown as Record<string, unknown>,
        };
      },
    };

    const memberListParams = Type.Object({
      chat: Type.String({ description: '群会话标识,如 "group:123"' }),
      query: Type.Optional(
        Type.String({ description: "按 QQ 号 / 昵称 / 群名片过滤(不区分大小写);不填则按活跃度列最近发言的人" }),
      ),
      limit: Type.Optional(Type.Number({ description: "最多返回几条,默认 30,最多 100" })),
    });
    const listGroupMembers: AgentTool<typeof memberListParams> = {
      name: "list_group_members",
      label: "看群成员",
      description:
        "列出群成员及其 QQ 号(可按昵称/QQ 搜索)。想找某个人是谁、想主动私聊某位群友时先用它拿 QQ 号,再用 send_message 发 private:<QQ>。",
      parameters: memberListParams,
      execute: async (_id, params: { chat: string; query?: string; limit?: number }) => {
        const groupId = Number(params.chat.split(":")[1]);
        if (!Number.isFinite(groupId)) throw new Error(`会话标识不合法: ${params.chat}`);
        const all = (await client().call("get_group_member_list", { group_id: groupId })) as {
          user_id: number;
          nickname?: string;
          card?: string;
          role?: string;
          title?: string;
          last_sent_time?: number;
        }[];
        const q = (params.query ?? "").trim().toLowerCase();
        const limit = Math.min(Math.max(Math.round(params.limit ?? 30), 1), 100);
        const roleRank: Record<string, number> = { owner: 3, admin: 2, member: 1 };
        const filtered = (Array.isArray(all) ? all : [])
          .filter((m) => {
            if (!q) return true;
            return (
              String(m.user_id).includes(q) ||
              (m.nickname ?? "").toLowerCase().includes(q) ||
              (m.card ?? "").toLowerCase().includes(q)
            );
          })
          .sort((a, b) => {
            const byActivity = (b.last_sent_time ?? 0) - (a.last_sent_time ?? 0);
            if (byActivity !== 0) return byActivity;
            return (roleRank[b.role ?? "member"] ?? 0) - (roleRank[a.role ?? "member"] ?? 0);
          })
          .slice(0, limit);
        if (!filtered.length) {
          return {
            content: [{ type: "text", text: q ? `没有匹配「${params.query}」的群成员。` : "群里没有成员信息。" }],
            details: { groupId, count: 0 },
          };
        }
        const roleName = (r?: string) => ({ owner: "群主", admin: "管理", member: "" })[r ?? "member"] ?? "";
        const lines = filtered.map((m) => {
          const role = roleName(m.role);
          const name = m.card || m.nickname || String(m.user_id);
          return `- ${m.user_id} ${name}${role ? `(${role})` : ""}${m.title ? ` 头衔:${m.title}` : ""}`;
        });
        return {
          content: [
            {
              type: "text",
              text: `群 ${groupId} 成员(${filtered.length}/${Array.isArray(all) ? all.length : 0}):\n${lines.join("\n")}`,
            },
          ],
          details: { groupId, count: filtered.length, total: Array.isArray(all) ? all.length : 0 },
        };
      },
    };

    const strangerParams = Type.Object({
      user: Type.Number({ description: "对方 QQ 号" }),
    });
    const getStrangerInfo: AgentTool<typeof strangerParams> = {
      name: "get_stranger_info",
      label: "看陌生人资料",
      description:
        "查一个 QQ 号的基本资料(昵称、性别、年龄、签名),用于私聊前了解对方是谁。对方不是好友也能查(取决于隐私设置)。",
      parameters: strangerParams,
      execute: async (_id, params: { user: number }) => {
        const info = (await client().call("get_stranger_info", {
          user_id: params.user,
          no_cache: false,
        })) as { nickname?: string; sex?: string; age?: number; sign?: string; qid?: string };
        const bits = [
          info.nickname ?? String(params.user),
          info.sex && info.sex !== "unknown" ? info.sex : "",
          info.age ? `${info.age} 岁` : "",
          info.qid ? `QID:${info.qid}` : "",
        ].filter(Boolean);
        return {
          content: [
            {
              type: "text",
              text: `${bits.join(" · ")}${info.sign ? `\n签名:${info.sign}` : ""}`,
            },
          ],
          details: info as unknown as Record<string, unknown>,
        };
      },
    };

    // ---------- 表情回应 ----------

    const emojiParams = Type.Object({
      messageId: Type.Number({ description: "消息 id(read_messages 输出里的 id)" }),
      emojiId: Type.String({ description: 'QQ 表情 ID,如 "128077" 是👍' }),
    });
    const setMsgEmojiLike: AgentTool<typeof emojiParams> = {
      name: "set_msg_emoji_like",
      label: "贴表情",
      description: "给某条消息贴一个表情回应。常用表情 ID:128077 赞、128514 笑哭、128169 便便、10017 OK。",
      parameters: emojiParams,
      execute: async (_id, params: { messageId: number; emojiId: string }) => {
        await client().call("set_msg_emoji_like", {
          message_id: params.messageId,
          emoji_id: params.emojiId,
        });
        return { content: [{ type: "text", text: "表情贴上了。" }], details: { ...params } };
      },
    };

    const markParams = Type.Object({
      chat: Type.String({ description: '会话标识,如 "group:123"' }),
    });
    const markRead: AgentTool<typeof markParams> = {
      name: "mark_read",
      label: "标记已读",
      description: "把某个会话标成已读(未读清零),不用真的回。",
      parameters: markParams,
      execute: async (_id, params: { chat: string }) => {
        store().markRead(params.chat);
        return { content: [{ type: "text", text: "已读。" }], details: {} };
      },
    };

    const emptyParams = Type.Object({});
    const listFriends: AgentTool<typeof emptyParams> = {
      name: "list_friends",
      label: "看好友列表",
      description: "翻翻通讯录:好友都有谁。",
      parameters: emptyParams,
      execute: async () => {
        const friends = store().getFriends();
        const lines = friends.map((f) => `- ${f.remark || f.nickname}(${f.user_id})`);
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "通讯录是空的。" }],
          details: { count: friends.length },
        };
      },
    };

    const listGroups: AgentTool<typeof emptyParams> = {
      name: "list_groups",
      label: "看群列表",
      description: "翻翻通讯录:都加了哪些群。",
      parameters: emptyParams,
      execute: async () => {
        const groups = store().getGroups();
        const lines = groups.map((g) => `- ${g.group_name}(${g.group_id})`);
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "没有加任何群。" }],
          details: { count: groups.length },
        };
      },
    };

    const profileParams = Type.Object({});
    const getProfile: AgentTool<typeof profileParams> = {
      name: "get_profile",
      label: "看自己的资料",
      description: "看看自己的 QQ 号和昵称。",
      parameters: profileParams,
      execute: async () => {
        try {
          const info = (await client().call("get_login_info")) as { user_id: number; nickname: string };
          return {
            content: [{ type: "text", text: `你是 ${info.nickname}(${info.user_id})。` }],
            details: info,
          };
        } catch {
          return {
            content: [{ type: "text", text: "现在连不上 QQ,看不了资料。" }],
            details: {},
          };
        }
      },
    };

    const atParams = Type.Object({
      n: Type.Optional(Type.Number({ description: "看最近几条@,默认 10" })),
    });
    const recentAt: AgentTool<typeof atParams> = {
      name: "get_recent_at_mentions",
      label: "谁在@我",
      description: "最近有哪些消息@了你(含全体@)。",
      parameters: atParams,
      execute: async (_id, params: { n?: number }) => {
        const mentions = store().recentAtMentions(Math.min(params.n ?? 10, 30));
        const lines = mentions.map(
          (m) => `- [${m.chatKey}] ${m.senderName}: ${m.text.slice(0, 60)}(${new Date(m.msgTime * 1000).toLocaleString("zh-CN")})`,
        );
        return {
          content: [{ type: "text", text: lines.length ? `最近的@:\n${lines.join("\n")}` : "最近没有人@你。" }],
          details: { count: mentions.length },
        };
      },
    };

    const pokeParams = Type.Object({
      groupId: Type.Optional(
        Type.Number({ description: "群号(get_recent_at_mentions 里 group:xxx 的数字);私聊戳人不填" }),
      ),
      userId: Type.Number({ description: "对方的 QQ 号" }),
    });
    const pokeUser: AgentTool<typeof pokeParams> = {
      name: "poke_user",
      label: "戳一戳某人",
      description:
        "戳某人一下:在群里要带上群号,私聊不填群号。被戳了想回戳、或者想轻轻提醒某人注意一下时用它。不是每条消息都值得回一戳,克制一点。",
      parameters: pokeParams,
      execute: async (_id, params) => {
        if (params.groupId) {
          await client().call("group_poke", { group_id: params.groupId, user_id: params.userId });
          return {
            content: [{ type: "text", text: `你在群里戳了 ${params.userId} 一下。` }],
            details: { groupId: params.groupId, userId: params.userId },
          };
        }
        // 私聊戳:OneBot 扩展动作 friend_poke(SnowLuma/NapCat 均支持);
        // 个别实现只认 send_poke,故失败时回退一次
        try {
          await client().call("friend_poke", { user_id: params.userId });
        } catch {
          await client().call("send_poke", { user_id: params.userId });
        }
        return {
          content: [{ type: "text", text: `你戳了 ${params.userId} 一下。` }],
          details: { userId: params.userId },
        };
      },
    };

    // ---------- 图片:多模态查看 + 表情包库 ----------

    /** 消息 id → 可下载 url(优先用入库 url,缺失时走 get_image) */
    const resolveImageUrl = async (messageId: number, imageIndex: number): Promise<string> => {
      const images = store().getMessageImages(messageId);
      if (images.length === 0) throw new Error(`消息 ${messageId} 里没有图片`);
      const idx = Math.min(Math.max(imageIndex, 0), images.length - 1);
      const img = images[idx]!;
      if (img.url) return img.url;
      const info = (await client().call("get_image", { file: img.file })) as { url?: string; file?: string };
      if (!info.url) throw new Error("拿不到图片地址(get_image 无 url)");
      return info.url;
    };

    const viewImgParams = Type.Object({
      messageId: Type.Number({ description: "消息 id" }),
      imageIndex: Type.Optional(Type.Number({ description: "第几张图(从 0 开始),默认第一张" })),
    });
    const viewMessageImage: AgentTool<typeof viewImgParams> = {
      name: "view_message_image",
      label: "看消息里的图",
      description: "用眼睛看某条消息里的图片(需要模型支持看图)。配合 read_messages 输出里的 [图片×N] 使用。",
      parameters: viewImgParams,
      execute: async (_id, params: { messageId: number; imageIndex?: number }) => {
        const url = await resolveImageUrl(params.messageId, params.imageIndex ?? 0);
        const { b64, mime } = await fetchImage(url);
        return {
          content: [
            { type: "text", text: `这是消息 ${params.messageId} 里的图片:` },
            { type: "image", data: b64, mimeType: mime },
          ],
          details: { messageId: params.messageId, mime },
        };
      },
    };

    const saveMemeParams = Type.Object({
      messageId: Type.Number({ description: "消息 id" }),
      imageIndex: Type.Optional(Type.Number({ description: "第几张图(从 0 开始)" })),
      name: Type.Optional(Type.String({ description: "给表情包起的名字;不填自动编号" })),
    });
    const saveMemeFromMessage: AgentTool<typeof saveMemeParams> = {
      name: "save_meme_from_message",
      label: "收藏表情包",
      description: "把消息里的图片存进自己的表情包库。同名已存在时不覆盖。",
      parameters: saveMemeParams,
      execute: async (_id, params: { messageId: number; imageIndex?: number; name?: string }) => {
        const url = await resolveImageUrl(params.messageId, params.imageIndex ?? 0);
        const { b64, mime } = await fetchImage(url);
        const ext = IMG_MIME_EXT[mime] ?? "png";
        const autoName = params.name?.trim() || `meme_${Date.now().toString(36)}`;
        const file = resolve(this.memeDir, `${autoName.replace(/[\\/:*?"<>|]/g, "_")}.${ext}`);
        writeFileSync(file, Buffer.from(b64, "base64"));
        const { id, existed } = store().addMeme(autoName, file, mime, null);
        return {
          content: [
            {
              type: "text",
              text: existed ? `表情包库里已经有「${autoName}」了,没有覆盖。` : `已收藏为表情包「${autoName}」。`,
            },
          ],
          details: { id, name: autoName, existed },
        };
      },
    };

    const listMemesParams = Type.Object({
      search: Type.Optional(Type.String({ description: "按名字模糊找;不填列出全部" })),
    });
    const listMemes: AgentTool<typeof listMemesParams> = {
      name: "list_memes",
      label: "翻表情包库",
      description: "看看自己的表情包库都有哪些(支持按名字模糊搜)。",
      parameters: listMemesParams,
      execute: async (_id, params: { search?: string }) => {
        const memes = store().listMemes(params.search);
        const lines = memes.map((m) => `- ${m.name}`);
        return {
          content: [{ type: "text", text: lines.length ? lines.join("\n") : "表情包库还是空的。" }],
          details: { count: memes.length },
        };
      },
    };

    const viewMemeParams = Type.Object({
      name: Type.String({ description: "表情包名字(支持模糊匹配)" }),
    });
    const viewMeme: AgentTool<typeof viewMemeParams> = {
      name: "view_meme",
      label: "看表情包",
      description: "看看表情包库里某张图长什么样(需要模型支持看图)。",
      parameters: viewMemeParams,
      execute: async (_id, params: { name: string }) => {
        const meme = store().getMeme(params.name);
        if (!meme) throw new Error(`表情包库里没有「${params.name}」`);
        const content = await readFile(meme.file);
        return {
          content: [
            { type: "text", text: `这是表情包「${meme.name}」:` },
            { type: "image", data: content.toString("base64"), mimeType: meme.mime },
          ],
          details: { name: meme.name, mime: meme.mime },
        };
      },
    };

    const sendMemeParams = Type.Object({
      chat: Type.String({ description: '会话标识,如 "group:123"' }),
      memeName: Type.String({ description: "表情包名字(支持模糊匹配)" }),
      caption: Type.Optional(Type.String({ description: "配文(可选)" })),
      replyTo: Type.Optional(Type.Number({ description: "要引用回复的消息 id(可选)" })),
    });
    const sendMeme: AgentTool<typeof sendMemeParams> = {
      name: "send_meme",
      label: "发表情包",
      description: "从自己的表情包库里挑一张发出去,可以配文、可以引用回复。",
      parameters: sendMemeParams,
      execute: async (_id, params: { chat: string; memeName: string; caption?: string; replyTo?: number }) => {
        const [type, idStr] = params.chat.split(":");
        const id = Number(idStr);
        if ((type !== "group" && type !== "private") || !Number.isFinite(id)) {
          throw new Error(`会话标识不合法: ${params.chat}`);
        }
        const meme = store().getMeme(params.memeName);
        if (!meme) throw new Error(`表情包库里没有「${params.memeName}」`);
        const data = (await readFile(meme.file)).toString("base64");
        const segments: ObSegment[] = [];
        if (params.replyTo != null) segments.push({ type: "reply", data: { id: String(params.replyTo) } });
        segments.push({ type: "image", data: { file: `base64://${data}` } });
        if (params.caption) segments.push({ type: "text", data: { text: params.caption } });
        await this.throttle.acquire();
        const messageId = await client().call(
          type === "group" ? "send_group_msg" : "send_private_msg",
          type === "group" ? { group_id: id, message: segments } : { user_id: id, message: segments },
        );
        return {
          content: [{ type: "text", text: `表情包「${meme.name}」发出去了。` }],
          details: { messageId, meme: meme.name },
        };
      },
    };

    const renameMemeParams = Type.Object({
      oldName: Type.String({ description: "现在的名字" }),
      newName: Type.String({ description: "新名字" }),
    });
    const renameMeme: AgentTool<typeof renameMemeParams> = {
      name: "rename_meme",
      label: "给表情包改名",
      description: "给收藏的表情包改个更好的名字。",
      parameters: renameMemeParams,
      execute: async (_id, params: { oldName: string; newName: string }) => {
        const ok = store().renameMeme(params.oldName, params.newName);
        if (!ok) throw new Error(`表情包库里没有「${params.oldName}」`);
        return {
          content: [{ type: "text", text: `「${params.oldName}」改名成了「${params.newName}」。` }],
          details: { ...params },
        };
      },
    };

    this.tools = [
      listChats,
      readMessages,
      sendMessage,
      markRead,
      listFriends,
      listGroups,
      getProfile,
      recentAt,
      // 戳一戳
      pokeUser,
      // 群管理
      setGroupBan,
      setGroupSpecialTitle,
      getGroupMemberInfo,
      // 群成员与陌生人
      listGroupMembers,
      getStrangerInfo,
      // 表情回应
      setMsgEmojiLike,
      // 图片/表情包
      viewMessageImage,
      saveMemeFromMessage,
      listMemes,
      viewMeme,
      sendMeme,
      renameMeme,
    ];
  }

  async stop(): Promise<void> {
    this.client?.close();
    this.client = null;
    this.store?.close();
    this.store = null;
    this.host = null;
  }
}
