import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { flattenMessage, type ObFriend, type ObGroup, type ObMessageEvent, type ObSegment } from "./client.js";

export interface ChatRow {
  chatKey: string; // "group:123" | "private:456"
  chatType: "group" | "private";
  chatId: number;
  title: string;
  lastMsgText: string;
  lastMsgTime: number;
  unread: number;
}

/**
 * napcat 模块私有存储:消息流水、未读游标、@提及。
 * OneBot/NapCat 没有「未读」概念 —— 未读 = 自维护的 per-chat 已读游标之后的条数。
 */
export class NapcatStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const p = resolve(dbPath);
    if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
    this.db = new Database(p);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id INTEGER NOT NULL,
        chat_key TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        chat_id INTEGER NOT NULL,
        sender_id INTEGER,
        sender_name TEXT,
        text TEXT NOT NULL,
        images TEXT NOT NULL DEFAULT '[]',
        at_me INTEGER NOT NULL DEFAULT 0,
        msg_time INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_key, id);
      CREATE TABLE IF NOT EXISTS cursors (
        chat_key TEXT PRIMARY KEY,
        last_read_msg_row INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS at_mentions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_key TEXT NOT NULL,
        sender_name TEXT,
        text TEXT,
        msg_time INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE TABLE IF NOT EXISTS memes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        file TEXT NOT NULL,
        mime TEXT NOT NULL,
        source_chat TEXT,
        created_at INTEGER NOT NULL
      );
    `);
    this.migrateMessagesImages();
  }

  /** 旧库迁移:messages 表补 images 列 */
  private migrateMessagesImages(): void {
    const cols = this.db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "images")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN images TEXT NOT NULL DEFAULT '[]'");
    }
  }

  insertMessage(e: ObMessageEvent, _selfId: number, atMe: boolean): void {
    const chatType = e.message_type;
    const chatId = chatType === "group" ? (e.group_id ?? 0) : e.user_id;
    const chatKey = `${chatType}:${chatId}`;
    const senderName = e.sender?.card || e.sender?.nickname || String(e.user_id);
    const segments: ObSegment[] = Array.isArray(e.message)
      ? e.message
      : [{ type: "text", data: { text: e.message } }];
    const text = flattenMessage(segments);
    const images = segments
      .filter((s) => s.type === "image")
      .map((s) => ({ url: String(s.data.url ?? ""), file: String(s.data.file ?? "") }));
    this.db
      .prepare(
        `INSERT INTO messages(message_id, chat_key, chat_type, chat_id, sender_id, sender_name, text, images, at_me, msg_time)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(e.message_id, chatKey, chatType, chatId, e.user_id, senderName, text, JSON.stringify(images), atMe ? 1 : 0, e.time);
    if (atMe) {
      this.db
        .prepare("INSERT INTO at_mentions(chat_key, sender_name, text, msg_time) VALUES (?,?,?,?)")
        .run(chatKey, senderName, text, e.time);
    }
  }

  /** 某条消息里的图片引用 [{url, file}] */
  getMessageImages(onebotMessageId: number): { url: string; file: string }[] {
    const row = this.db.prepare("SELECT images FROM messages WHERE message_id=? ORDER BY id DESC LIMIT 1").get(onebotMessageId) as
      | { images: string }
      | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.images) as { url: string; file: string }[];
    } catch {
      return [];
    }
  }

  chatsWithUnread(): ChatRow[] {
    const rows = this.db
      .prepare(
        `SELECT m.chat_key, m.chat_type, m.chat_id, MAX(m.id) AS last_row, MAX(m.msg_time) AS last_time
         FROM messages m GROUP BY m.chat_key ORDER BY last_time DESC LIMIT 50`,
      )
      .all() as { chat_key: string; chat_type: "group" | "private"; chat_id: number; last_row: number; last_time: number }[];
    const out: ChatRow[] = [];
    for (const r of rows) {
      const cur = this.db.prepare("SELECT last_read_msg_row FROM cursors WHERE chat_key=?").get(r.chat_key) as
        | { last_read_msg_row: number }
        | undefined;
      const lastRead = cur?.last_read_msg_row ?? 0;
      const unread = this.db
        .prepare("SELECT COUNT(*) AS n FROM messages WHERE chat_key=? AND id>?")
        .get(r.chat_key, lastRead) as { n: number };
      const last = this.db
        .prepare("SELECT text, sender_name FROM messages WHERE id=?")
        .get(r.last_row) as { text: string; sender_name: string } | undefined;
      out.push({
        chatKey: r.chat_key,
        chatType: r.chat_type,
        chatId: r.chat_id,
        title: this.chatTitle(r.chat_type, r.chat_id),
        lastMsgText: last ? `${last.sender_name}: ${last.text}`.slice(0, 80) : "",
        lastMsgTime: r.last_time,
        unread: unread.n,
      });
    }
    return out;
  }

  /** 读某个 chat 的最近 n 条(在游标之后的优先;读完由 mark_read 推进游标) */
  readMessages(chatKey: string, n: number): {
    rowId: number;
    messageId: number;
    senderName: string;
    text: string;
    imageCount: number;
    msgTime: number;
    atMe: boolean;
  }[] {
    const rows = this.db
      .prepare(
        `SELECT id, message_id, sender_name, text, images, msg_time, at_me FROM messages WHERE chat_key=? ORDER BY id DESC LIMIT ?`,
      )
      .all(chatKey, n) as { id: number; message_id: number; sender_name: string; text: string; images: string; msg_time: number; at_me: number }[];
    return rows.reverse().map((r) => ({
      rowId: r.id,
      messageId: r.message_id,
      senderName: r.sender_name,
      text: r.text,
      imageCount: (JSON.parse(r.images || "[]") as unknown[]).length,
      msgTime: r.msg_time,
      atMe: r.at_me === 1,
    }));
  }

  markRead(chatKey: string): void {
    const row = this.db
      .prepare("SELECT MAX(id) AS n FROM messages WHERE chat_key=?")
      .get(chatKey) as { n: number | null };
    this.db
      .prepare(
        `INSERT INTO cursors(chat_key, last_read_msg_row) VALUES (?,?)
         ON CONFLICT(chat_key) DO UPDATE SET last_read_msg_row=excluded.last_read_msg_row`,
      )
      .run(chatKey, row.n ?? 0);
  }

  recentAtMentions(limit: number): { chatKey: string; senderName: string; text: string; msgTime: number }[] {
    const rows = this.db
      .prepare("SELECT chat_key, sender_name, text, msg_time FROM at_mentions ORDER BY id DESC LIMIT ?")
      .all(limit) as { chat_key: string; sender_name: string; text: string; msg_time: number }[];
    return rows.map((r) => ({
      chatKey: r.chat_key,
      senderName: r.sender_name,
      text: r.text,
      msgTime: r.msg_time,
    }));
  }

  saveMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  cacheFriends(friends: ObFriend[]): void {
    this.saveMeta("friends", JSON.stringify(friends));
  }

  getFriends(): ObFriend[] {
    const raw = this.getMeta("friends");
    return raw ? (JSON.parse(raw) as ObFriend[]) : [];
  }

  cacheGroups(groups: ObGroup[]): void {
    this.saveMeta("groups", JSON.stringify(groups));
  }

  getGroups(): ObGroup[] {
    const raw = this.getMeta("groups");
    return raw ? (JSON.parse(raw) as ObGroup[]) : [];
  }

  /** 会话标题:优先群名/好友备注 */
  private chatTitle(chatType: string, chatId: number): string {
    if (chatType === "group") {
      const g = this.getGroups().find((x) => x.group_id === chatId);
      return g?.group_name ?? `群 ${chatId}`;
    }
    const f = this.getFriends().find((x) => x.user_id === chatId);
    return f?.remark || f?.nickname || `好友 ${chatId}`;
  }

  // ---------- 表情包库 ----------

  addMeme(name: string, file: string, mime: string, sourceChat: string | null): { id: number; existed: boolean } {
    const dup = this.db.prepare("SELECT id FROM memes WHERE name=?").get(name) as { id: number } | undefined;
    if (dup) return { id: dup.id, existed: true };
    const info = this.db
      .prepare("INSERT INTO memes(name, file, mime, source_chat, created_at) VALUES (?,?,?,?,?)")
      .run(name, file, mime, sourceChat, Date.now());
    return { id: Number(info.lastInsertRowid), existed: false };
  }

  listMemes(search?: string): { id: number; name: string; source_chat: string | null; created_at: number }[] {
    if (search) {
      return this.db
        .prepare("SELECT id, name, source_chat, created_at FROM memes WHERE name LIKE ? ORDER BY id DESC LIMIT 50")
        .all(`%${search}%`) as { id: number; name: string; source_chat: string | null; created_at: number }[];
    }
    return this.db
      .prepare("SELECT id, name, source_chat, created_at FROM memes ORDER BY id DESC LIMIT 100")
      .all() as { id: number; name: string; source_chat: string | null; created_at: number }[];
  }

  getMeme(name: string): { id: number; name: string; file: string; mime: string } | undefined {
    const exact = this.db.prepare("SELECT id, name, file, mime FROM memes WHERE name=?").get(name) as
      | { id: number; name: string; file: string; mime: string }
      | undefined;
    if (exact) return exact;
    const like = this.db.prepare("SELECT id, name, file, mime FROM memes WHERE name LIKE ? LIMIT 1").get(`%${name}%`) as
      | { id: number; name: string; file: string; mime: string }
      | undefined;
    return like;
  }

  renameMeme(oldName: string, newName: string): boolean {
    const info = this.db.prepare("UPDATE memes SET name=? WHERE name=?").run(newName, oldName);
    return info.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
