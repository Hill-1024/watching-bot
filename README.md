# watching-bot

自循环拟人 agent:以 [pi](https://github.com/earendil-works/pi)(`pi-agent-core` + `pi-ai`,库模式)为 agent 基底,外挂一套 **LLM 不可见的隐藏状态机**(疲惫/心情/烦躁/压力/社交电量)与**睡醒调度器**。状态达到阈值时通过「混合注入」影响模型的内心独白,让它真的会困、会烦、会赖床。QQ 能力由 [NapCat](https://github.com/NapNeko/NapCatQQ)(OneBot 11)通过**模块总线**以黑箱工具的形式提供。

```
                 ┌──────────────────────────┐
                 │ 状态管理 StateManager      │ 隐藏,LLM 不可见
                 │ 只监控 agent 本体          │
                 └─────╮──────────╭─────────┘
              事件总线(sub)│      │命令 API(inject/forceSleep/wake)
                 ┌───────╯────────╰──────╮
                 │  核心 core(agent 承载)  │
                 │  pi Agent + 无限循环     │
                 │  醒睡状态机+clock+注入器  │
                 └───────────╮───────────┘
                             │ 唯一边界:模块总线 ModuleBus
              ┌──────────────┼──────────────┬─────────────┐
           napcat      mock(测试)     未来:其他IM/沙箱电脑/联网搜索
```

依赖方向铁律:`modules → bus ← core ← state-manager`。对 agent 而言,所有模块只是一堆可调用的黑箱工具;模块任意插拔,agent 代码零改动。状态管理器只消费核心事件流(带 `social` 等语义标签的工具调用、归一化的感知事件),永远不认识具体模块。

## 快速开始

```bash
npm install

# 无密钥全链路体验(faux 剧本 LLM + mock 模块 + 假 QQ)
npm run mock:onebot           # 终端 1:假 OneBot 服务器(--storm 可立即触发@风暴)
WATCHING_BOT_FAUX_LLM=1 WATCHING_BOT_TIMESCALE=300 npm start
# 打开 http://127.0.0.1:8080/?token= 管理面板(timeScale=300 → 1 真实秒 = 5 模拟分钟)
```

接真实模型与真实 QQ:

1. 设置环境变量 `WATCHING_BOT_API_KEY`(OpenAI 兼容端点的 key,默认 GLM,见 `config/default.json` 的 `model` 段)。
2. 起 NapCat 并扫码登录:
   ```bash
   docker compose up -d napcat   # WebUI http://127.0.0.1:6099 扫码
   # 在 NapCat WebUI → 网络配置 → 新建「WebSocket 服务器」,端口 3001,token 可选
   ```
3. `docker compose up -d watching-bot`(容器内自动 `NAPCAT_URL=ws://napcat:3001`),或本机 `npm start`。

## 系统机制速览

| 机制 | 行为 |
|---|---|
| 无限循环 | orchestrator 是唯一决定「何时调 LLM」的角色;模型做完事调 `wait`/`sleep`,run 自然结束即挂起;空响应指数退避兜底 |
| 混合注入 | 体感→伪造 assistant 内心独白 `<feeling>…</feeling>`;环境事件→`[环境]` 旁白。**状态数值永不进入提示词**(单测保证) |
| 睡眠 | `sleep` 工具自愿入睡;疲惫≥90 强制入睡。入睡时先做**睡眠期归并**(日记+MEMORY.md 长期记忆索引,日常压缩交给 pi 自带 compaction) |
| 唤醒 | 疲惫恢复≤15 自然醒 / 睡满 12 模拟时硬上限强制醒(系统行为);闹钟/@风暴 打断→注入唤醒信号,**模型自己决定起不起**(可调 `wake_up`,可调 `sleep` 继续赖床;闹钟每 10 分钟重响且文案升级,烦躁累积) |
| 闹钟 | `set_alarm`/`cancel_alarm` 工具,模型自己上弦 |
| QQ | 模块总线上的 napcat 模块,18 个工具:消息(list_chats 未读/read_messages 带消息 id/send_message 可引用回复/mark_read/get_recent_at_mentions/通讯录/get_profile);群管理(**set_group_ban 禁言、set_group_special_title 定制头衔**、get_group_member_info 查身份,权限不足由 OneBot 报错);表情(**set_msg_emoji_like 贴表情**);表情包(**view_message_image 多模态看图、save_meme_from_message 收藏、list_memes/view_meme/rename_meme/send_meme 发送**);新消息→「手机震了一下」体感,模型自己决定看不看 |
| judge | 双通道情绪修正:实时通道(风暴/闹钟触发廉价 LLM 判读)+ 睡眠通道(归并时的 `adjust_mood` 结算),冷却与每日上限双保险 |
| 面板 | http://127.0.0.1:8080(token 见 `WATCHING_BOT_PANEL_TOKEN`):实时状态/曲线/注入流水;直接改五维值、手动触发归并、强制醒睡、热调 timeScale、模块热插拔 |

## 目录

```
src/
├── index.ts        # 装配:core + state-manager + bus + modules[]
├── bus/            # 模块总线契约(types)与实现(host)—— 最重要的接口
├── core/           # pi Agent 装配、无限循环、醒睡状态机、timeScale 时钟、注入器、文案表
├── state/          # 五维规则引擎(纯函数)、状态管理器、judge
├── modules/
│   ├── napcat/     # 唯一了解 QQ 的地方:OneBot 11 WS client + 工具包 + 未读游标 + 节流
│   └── mock.ts     # 测试假模块(证明解耦)
├── memory/         # 睡眠期长期记忆归并(日记 + MEMORY.md 索引 + 周归并)
├── store/          # SQLite(状态历史/注入/睡眠记录/闹钟/事件)+ state.json 快照
└── web/            # 管理面板(读写)
third_party/napcat  # NapNeko/NapCatQQ 仓库指针(submodule,仅协议/源码参考,不参与构建)
tools/              # mock-onebot-server(假 QQ)、debug 脚本
tests/              # 状态引擎/文案安全单测
```

> `third_party/napcat` 是钉了 commit 的仓库指针:运行时我们只通过官方 Docker 镜像 + OneBot 11 WebSocket 与 NapCat 通信(跨进程,不 import 它的代码);这个指针用于对照协议实现、查扩展 API(如 `set_msg_emoji_like`)的源码行为。clone 后执行 `git submodule update --init` 拉取;`git submodule update --remote` 跟进上游。

## 写新模块

实现 `BotModule`(`src/bus/types.ts`)并在 `src/index.ts` 注册工厂即可,核心与状态管理零改动:

```ts
const myModule: BotModule = {
  name: "websearch",
  summary: "联网搜索:web_search 工具",
  tools: [ /* TypeBox 参数 + execute */ ],
  toolTags: { web_search: ["social"] /* 可选:语义标签给状态管理器 */ },
  async init(ctx) { /* ctx.emitPerception({kind:"message",intensity:1}) 上报感知 */ },
  async stop() {},
};
```

## 配置与验证

- 主配置 `config/default.json`:模型端点、timeScale、状态动力学参数、阈值、节流、面板 token 环境变量名。所有状态变量与阈值都是配置,加减维度不改代码。
- 无 QQ 全链路:`npm run mock:onebot` + `WATCHING_BOT_FAUX_LLM=1`;解耦验收:面板启停任意模块,核心/状态管理零改动照常运行。
- 状态引擎与注入文案有单测:`npm test`。
