import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModuleCtx } from "../src/bus/types.js";
import { NapcatModule } from "../src/modules/napcat/index.js";
import { SnowlumaModule } from "../src/modules/snowluma/index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-snowluma-"));
  dirs.push(dir);
  return dir;
}

function ctxFor(config: Record<string, unknown>): ModuleCtx {
  return {
    config,
    emitPerception: () => {},
    simNow: () => Date.now(),
    log: () => {},
  };
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
  "set_group_ban",
  "set_group_special_title",
  "get_group_member_info",
  "set_msg_emoji_like",
  "view_message_image",
  "save_meme_from_message",
  "list_memes",
  "view_meme",
  "send_meme",
  "rename_meme",
];

describe("SnowLuma module", () => {
  it("工具集与 NapCat 完全对齐,身份/摘要为 SnowLuma", async () => {
    const base = tempDir();
    const napcat = new NapcatModule();
    const snowluma = new SnowlumaModule();
    try {
      await napcat.init(ctxFor({
        url: "ws://127.0.0.1:1",
        dbPath: join(base, "napcat.db"),
        memeDir: join(base, "napcat-memes"),
      }));
      await snowluma.init(ctxFor({
        url: "ws://127.0.0.1:1",
        dbPath: join(base, "snowluma.db"),
        memeDir: join(base, "snowluma-memes"),
      }));

      expect(napcat.tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
      expect(snowluma.tools.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
      expect(snowluma.name).toBe("snowluma");
      expect(snowluma.summary).toContain("SnowLuma");
      expect(napcat.summary).toContain("napcat");
      expect(snowluma.toolTags?.send_message).toEqual(["social"]);
    } finally {
      await snowluma.stop();
      await napcat.stop();
    }
  });
});
