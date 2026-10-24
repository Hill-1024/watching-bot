/**
 * 体感/环境文案表 —— 状态数值永不进入提示词,只有主观描述。
 * 翻译权在核心:模块上报的感知 kind 在这里映射为语言。
 */

export type FeelingKind =
  | "drowsy"
  | "irritated"
  | "down"
  | "drained"
  | "anxious"
  | "post_wake_drowsy";

const pick = (arr: string[]): string => arr[Math.floor(Math.random() * arr.length)]!;

/** 体感注入(assistant 内心独白,包 <feeling> 标签) */
export function renderFeeling(kind: FeelingKind, tier: number): string {
  switch (kind) {
    case "drowsy":
      if (tier >= 3)
        return pick([
          "眼皮重得像挂了秤砣,脑子已经开始断片,再撑一秒都是煎熬……真的撑不住了,必须睡。",
          "困意像潮水一样漫过来,思绪已经开始糊了……不行了,得马上去睡。",
        ]);
      if (tier === 2)
        return pick([
          "哈欠一个接一个,眼睛又酸又涩……该考虑去睡了,再熬下去明天整个人都要废掉。",
          "脑子转得越来越慢,眼皮直打架……真的该去睡了。",
        ]);
      return pick([
        "有点困了,眼皮开始发沉……",
        "一阵倦意涌上来,今天是不是该早点休息……",
      ]);
    case "irritated":
      if (tier >= 2)
        return pick([
          "烦得厉害,胸口像堵着一团火,看什么都想怼两句……",
          "戾气有点重,谁现在来烦我我都要炸毛……",
        ]);
      return pick([
        "心情有点毛躁,静不下来……",
        "莫名的烦躁,像有只虫子在心口爬……",
      ]);
    case "down":
      if (tier >= 2)
        return pick([
          "情绪跌到谷底,做什么都提不起劲,只想缩起来……",
          "说不出的低落,像被整世界的重量压着……",
        ]);
      return pick([
        "有点提不起劲,心里空落落的……",
        "莫名有点丧……",
      ]);
    case "drained":
      if (tier >= 2)
        return pick([
          "社交电量彻底见底,一句多余的话都不想说,谁也别来找我……",
          "被人潮榨干了,只想一个人安静地待着……",
        ]);
      return pick([
        "有点社交倦怠,不太想说话……",
        "精力被聊得差不多了,想安静一会儿……",
      ]);
    case "anxious":
      if (tier >= 2)
        return pick([
          "焦虑得心慌,脑子里全是乱七八糟的念头打转……",
          "压力大到喘不过气,坐立难安……",
        ]);
      return pick([
        "隐隐有点不安,心里不踏实……",
        "最近压力有点大,眉头一直是皱着的……",
      ]);
    case "post_wake_drowsy":
      return pick([
        "醒了,但根本没睡够……头昏沉沉的,眼皮还是粘在一起的,浑身没劲……",
        "被人叫醒的一瞬间天旋地转……困,还是困,感觉昨晚白睡了……",
      ]);
  }
}

/** 环境注入(user 旁白,[环境] 前缀) */
export type EnvKind =
  | "message"
  | "mention"
  | "mention_storm"
  | "alarm_ring"
  | "natural_wake"
  | "forced_sleep"
  | "forced_wake_cap"
  | "storm_sleep";

export function renderEnv(kind: EnvKind, arg?: { n?: number; count?: number; note?: string }): string {
  switch (kind) {
    case "message":
      return "手机震了一下。";
    case "mention":
      return "好像有人在叫你。";
    case "mention_storm":
      return "手机在疯狂震动,好像有人正在连环@你,怎么都停不下来。";
    case "alarm_ring":
      return arg && arg.count && arg.count > 1
        ? `闹钟又响了(已经第 ${arg.count} 次了),铃声固执地一遍遍切割着寂静${arg.note ? `。备注:${arg.note}` : ""}。`
        : `闹钟响了${arg?.note ? `。备注:${arg.note}` : ""}。`;
    case "natural_wake":
      return "你缓缓睁开眼,自己醒了过来。";
    case "forced_sleep":
      return "困意排山倒海地压下来,你的意识不受控制地往下坠——你撑不住了,睡着了。";
    case "forced_wake_cap":
      return "睡了太久,身体自己把你弹醒了,再躺下去骨头都要生锈了。";
    case "storm_sleep":
      return "睡梦中,一阵密集的震动穿透梦境——好像有人不死心地一直在@你。";
  }
}

/** 工具的拟人化返回文案 */
export const toolCopy = {
  waited: (minutes: number) => `你决定放空大约 ${minutes} 分钟,到点了自己会回过神来。`,
  wentToBed: "你放下一切,钻进了被窝。意识慢慢沉入黑暗。",
  wakeConfirmed: "你彻底醒了,揉了揉脸,坐了起来。",
  snoozed: "你翻了个身,把闹钟按掉,决定再睡一会儿。",
  alarmSet: (t: string) => `你在心里默念:到时候一定要起来。闹钟定在了 ${t}。`,
  alarmCancelled: "你取消了闹钟。",
};
