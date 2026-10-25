# 模块开发指南

一切外部能力(IM、搜索、沙箱电脑…)都通过**模块总线**接入。写一个模块只需要实现 `BotModule` 契约并注册工厂 —— 核心与状态管理零改动,对 agent 而言它只是多了一堆黑箱工具。契约见 `src/bus/types.ts`,完整示例看 `src/modules/napcat/`(生产级)与 `src/modules/mock.ts`(最小)。

## 契约

```ts
import { Type } from "typebox";
import type { BotModule, ModuleCtx, PerceptionEvent } from "../bus/types.js";

export class MyModule implements BotModule {
  name = "websearch";
  summary = "联网搜索:web_search 工具";           // 进系统提示「可用能力」段
  toolTags = { web_search: [] };                  // 可选语义标签

  tools: AgentTool<any>[] = [];

  async init(ctx: ModuleCtx): Promise<void> {
    const cfg = (ctx.config ?? {}) as MyConfig;   // config/moduleConfig.websearch
    this.tools = [
      {
        name: "web_search",
        label: "联网搜索",
        description: "搜索互联网,返回结果摘要。",
        parameters: Type.Object({ query: Type.String({ description: "搜索词" }) }),
        execute: async (_id, params: { query: string }) => {
          const r = await search(params.query);
          return { content: [{ type: "text", text: r }], details: { n: r.length } };
        },
      },
    ];
  }

  // 有值得让 bot「感觉到」的外部事件时:
  //   ctx.emitPerception({ kind: "message", intensity: 1 });
  // 核心会把 kind 翻译成体感文案,模块永不碰提示词。

  async stop(): Promise<void> {}
}
```

注册(`src/index.ts`):

```ts
bus.registerFactory("websearch", () => new MyModule());
// config/default.json 的 modules 数组加 "websearch"
```

面板的模块热插拔走 `bus.startOne/stopOne`,注册了工厂即可被开关。

## 设计规则

1. **工具是黑箱**:工具的 name/description/参数 schema 由模块自述 —— 写 description 时直接对「角色本人」说话(参考 napcat 工具的写法:「看看最近有哪些会话,各自有多少未读」)。
2. **感知归一化**:上报用开放小枚举 `kind: message | mention | mention_storm | alert` + `intensity 1-5`。高频事件(如连环@)不必自己判断风暴 —— 只管上报 `mention`,核心按时间窗聚合成 `mention_storm`。新模块优先复用现有 kind;确实要新 kind 时在核心文案表(`src/core/copy.ts`)加一行映射。
3. **时间用 `ctx.simNow()`**,不要用 `Date.now()`(除非是纯真实时间的操作,如发请求的 timeout)。
4. **自带持久化**:模块数据存自己的库(参考 napcat 的 `data/modules/napcat.db`),核心不读模块库,模块不读核心库。
5. **语义标签**:若某工具代表「社交行为」,给它打 `social` 标签 —— 状态管理器会消耗社交电量/提升心情。它不认识你的工具名,只认识标签。

## SnowLuma 模块

`src/modules/snowluma/` 是第二套 QQ 接入运行时。SnowLuma 提供 OneBot 11(含 `set_msg_emoji_like` 等扩展),因此它直接复用 `NapcatModule` 的 18 个工具实现,只替换模块身份与能力摘要,保证工具集完全对齐。面板「QQ 接入」选择器在 NapCat / SnowLuma 之间互斥切换,默认 NapCat;选择写入 `data/qq-backend.json`。两套模块共用消息库与表情包目录,切换后历史延续。

## napcat 模块的 18 个工具(参考实现)

消息与通讯录:

| 工具 | 一句话 |
|---|---|
| `list_chats` | 会话列表 + 未读数(自维护已读游标,OneBot 无未读概念) |
| `read_messages` | 读会话最近消息,每条带 `(id:消息号)` 与 `[图片×N]` 标记 |
| `send_message` | 发消息;`replyTo` 引用回复;节流防风控 |
| `mark_read` | 已读(未读清零),不用回 |
| `get_recent_at_mentions` | 谁在@我 |
| `list_friends` / `list_groups` / `get_profile` | 通讯录/自己资料 |

群管理(权限不足由 OneBot 报错自然反馈):

| 工具 | 一句话 |
|---|---|
| `set_group_ban` | 禁言/解除(分钟制) |
| `set_group_special_title` | 发/撤销定制头衔 |
| `get_group_member_info` | 查身份(群主/管理员/成员) |

表情与表情包:

| 工具 | 一句话 |
|---|---|
| `set_msg_emoji_like` | 给消息贴表情回应 |
| `view_message_image` | 多模态看消息里的图(工具结果返回 ImageContent) |
| `save_meme_from_message` | 收藏消息里的图为表情包 |
| `list_memes` / `view_meme` / `rename_meme` | 翻库/看图/改名 |
| `send_meme` | 发表情包(base64 段,可配文可引用) |

实现分三个文件:`client.ts`(WS 连接/断线重连/动作调用)、`store.ts`(私有 SQLite:消息流水/游标/@提及/表情包索引)、`index.ts`(模块本体+工具)。多模态的关键:pi 的工具结果 content 支持 `{type:"image", data: base64, mimeType}`,模型支持看图就能真看到。

## 测试你的模块

1. **无 QQ 全链路**:给 mock-onebot 加你需要的假动作(`tools/mock-onebot-server.ts`),faux 模式跑通;
2. **解耦验收**:面板启停你的模块,确认核心/状态管理零改动;模块 stop 后工具应从 agent 消失(能力段动态更新);
3. **感知链路**:从模块 emit 一条 perception,日志应出现对应体感注入(`[state] 注入体感` / injections 表)。
