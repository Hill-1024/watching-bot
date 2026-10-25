import type { BotModule } from "../../bus/types.js";
import { NapcatModule } from "../napcat/index.js";

/**
 * SnowLuma:另一套 OneBot 11 运行时。
 *
 * SnowLuma 已实现 OneBot v11 动作及 set_msg_emoji_like 等扩展,因此这里直接复用
 * NapcatModule 的 18 个工具实现,只替换模块身份与能力描述,保证两套后端能力完全对齐。
 * 默认共用 data/modules/napcat.db 与表情包目录,切换运行时后消息、未读和表情包延续。
 */
export class SnowlumaModule extends NapcatModule {
  name = "snowluma";
  summary =
    "QQ(SnowLuma):list_chats 看会话与未读、read_messages 读消息、send_message 回消息(可引用回复)、mark_read 已读、list_friends/list_groups 通讯录、get_recent_at_mentions 谁在@你、get_profile 自己的资料;当群管理:set_group_ban 禁言、set_group_special_title 发定制头衔、get_group_member_info 查身份;贴表情 set_msg_emoji_like;表情包:list_memes/view_meme(多模态看图)/save_meme_from_message 收藏消息里的图/rename_meme 命名/send_meme 发表情包";
}

export function snowlumaModuleFactory(): BotModule {
  return new SnowlumaModule();
}
