import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OneBotAdapter } from "../plugins/qq/server/onebot/adapter.js";
import { RUNTIMES, loginInfoOf, oneBotToken, oneBotUrl } from "../plugins/qq/server/runtimes.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-qq-"));
  dirs.push(dir);
  return dir;
}

const EXPECTED_TOOLS = [
  "list_chats",
  "read_messages",
  "send_message",
  "mark_read",
  "list_friends",
  "list_groups",
  "get_profile",
  "get_recent_at_mentions",
  "poke_user",
  "set_group_ban",
  "set_group_special_title",
  "get_group_member_info",
  "list_group_members",
  "get_stranger_info",
  "set_msg_emoji_like",
  "view_message_image",
  "save_meme_from_message",
  "list_memes",
  "view_meme",
  "send_meme",
  "rename_meme",
];

describe("QQ 单插件 · 一份 OneBot 能力", () => {
  it("NapCat 与 SnowLuma 端点共用同一个适配器,工具集完全一致", async () => {
    const base = tempDir();
    const host = { emitPerception: () => {}, log: () => {} };

    const napcat = new OneBotAdapter();
    const snowluma = new OneBotAdapter();
    try {
      await napcat.connect(
        {
          url: oneBotUrl("napcat", {}),
          dbPath: join(base, "napcat.db"),
          memeDir: join(base, "napcat-memes"),
        },
        host,
      );
      await snowluma.connect(
        {
          url: oneBotUrl("snowluma", { supervisorUrl: "http://supervisor:8099" }),
          dbPath: join(base, "snowluma.db"),
          memeDir: join(base, "snowluma-memes"),
        },
        host,
      );

      expect(napcat.tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
      expect(snowluma.tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
      expect(napcat.toolTags.send_message).toEqual(["social"]);
      expect(snowluma.toolTags.send_message).toEqual(["social"]);
    } finally {
      await snowluma.stop();
      await napcat.stop();
    }
  });

  it("同一账号共用消息库与表情包目录,登录卷才按 runtime 分离", () => {
    // 共享数据路径是插件配置的默认值,不随 runtime 变化
    expect(oneBotUrl("napcat", { napcatUrl: "ws://127.0.0.1:3001" })).toBe("ws://127.0.0.1:3001");
    expect(oneBotUrl("snowluma", { supervisorUrl: "http://supervisor:8099" })).toBe("ws://snowluma:3001");
    expect(oneBotUrl("napcat", { supervisorUrl: "http://supervisor:8099" })).toBe("ws://napcat:3001");
    expect(oneBotToken("snowluma", { snowlumaToken: "s3cret" })).toBe("s3cret");
  });

  it("登录信息是展示抽象:两套 runtime 各自给出入口与说明", () => {
    const napcat = loginInfoOf("napcat", {});
    const snowluma = loginInfoOf("snowluma", {});
    expect(napcat.webuiUrl).toContain("6099");
    expect(napcat.remoteDesktopUrl).toBeUndefined();
    expect(snowluma.webuiUrl).toContain("5099");
    expect(snowluma.remoteDesktopUrl).toContain("6081");
    expect(snowluma.instructions.join(" ")).toContain("扫码");
    expect(RUNTIMES.snowluma.securityNotes.join(" ")).toContain("SYS_PTRACE");
  });
});
