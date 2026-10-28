import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { OneBotAdapter } from "../plugins/qq/server/onebot/adapter.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-qq-media-"));
  dirs.push(dir);
  return dir;
}

interface Captured {
  action: string;
  params: Record<string, unknown>;
}

async function withMockOneBot(run: (url: string, captured: Captured[]) => Promise<void>): Promise<void> {
  const captured: Captured[] = [];
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { action?: string; params?: Record<string, unknown>; echo?: string };
      if (!msg.action) return;
      captured.push({ action: msg.action, params: msg.params ?? {} });
      let data: unknown = {};
      switch (msg.action) {
        case "get_login_info":
          data = { user_id: 10000, nickname: "bot" };
          break;
        case "send_group_msg":
        case "send_private_msg":
          data = { message_id: 42 };
          break;
        default:
          data = {};
      }
      ws.send(JSON.stringify({ status: "ok", retcode: 0, data, echo: msg.echo }));
    });
  });

  const address = wss.address();
  if (typeof address === "string" || !address) throw new Error("mock server 没有端口");
  try {
    await run(`ws://127.0.0.1:${address.port}`, captured);
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
}

async function waitConnected(adapter: OneBotAdapter): Promise<void> {
  for (let i = 0; i < 100 && !adapter.connected; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!adapter.connected) throw new Error("适配器没有连上 mock OneBot");
}

describe("QQ send_message:图片与文件", () => {
  it("群聊里图片走 base64 segment,文件走 upload_group_file", async () => {
    const dir = tempDir();
    const filePath = join(dir, "report.txt");
    writeFileSync(filePath, "hello file", "utf-8");

    await withMockOneBot(async (url, captured) => {
      const adapter = new OneBotAdapter();
      try {
        await adapter.connect(
          {
            url,
            dbPath: join(dir, "napcat.db"),
            memeDir: join(dir, "memes"),
            selfId: 10000,
            sendMinIntervalMs: 0,
            sendJitterMs: 0,
          },
          { emitPerception: () => {}, log: () => {} },
        );
        await waitConnected(adapter);

        const tool = adapter.tools.find((t) => t.name === "send_message");
        if (!tool) throw new Error("没有 send_message");
        await tool.execute("t", {
          chat: "group:123",
          text: "看图",
          images: ["data:image/png;base64,iVBORw0KGgo="],
          files: [filePath],
        } as never);

        const send = captured.find((c) => c.action === "send_group_msg");
        expect(send).toBeTruthy();
        const segments = send!.params.message as { type: string; data: Record<string, unknown> }[];
        expect(segments[0]).toEqual({ type: "text", data: { text: "看图" } });
        expect(segments[1]).toEqual({ type: "image", data: { file: "base64://iVBORw0KGgo=" } });

        const upload = captured.find((c) => c.action === "upload_group_file");
        expect(upload).toBeTruthy();
        expect(upload!.params).toMatchObject({ group_id: 123, file: filePath, name: "report.txt" });
      } finally {
        await adapter.stop();
      }
    });
  });

  it("私聊只发文件时用 upload_private_file,不额外发空消息", async () => {
    const dir = tempDir();
    const filePath = join(dir, "note.md");
    writeFileSync(filePath, "# note", "utf-8");

    await withMockOneBot(async (url, captured) => {
      const adapter = new OneBotAdapter();
      try {
        await adapter.connect(
          {
            url,
            dbPath: join(dir, "napcat.db"),
            memeDir: join(dir, "memes"),
            selfId: 10000,
            sendMinIntervalMs: 0,
            sendJitterMs: 0,
          },
          { emitPerception: () => {}, log: () => {} },
        );
        await waitConnected(adapter);

        const tool = adapter.tools.find((t) => t.name === "send_message");
        if (!tool) throw new Error("没有 send_message");
        await tool.execute("t", { chat: "private:456", files: [filePath] } as never);

        expect(captured.some((c) => c.action === "send_private_msg")).toBe(false);
        const upload = captured.find((c) => c.action === "upload_private_file");
        expect(upload).toBeTruthy();
        expect(upload!.params).toMatchObject({ user_id: 456, file: filePath, name: "note.md" });
      } finally {
        await adapter.stop();
      }
    });
  });
});
