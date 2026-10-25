# watching-bot

自循环拟人 agent:以 [pi](https://github.com/earendil-works/pi)(`pi-agent-core` + `pi-ai`,库模式)为基底,外挂一套 **LLM 不可见的隐藏状态机**(疲惫/心情/烦躁/压力/社交电量)与**睡醒调度器**。状态达到阈值时通过「混合注入」影响模型的内心独白,让它真的会困、会烦、会赖床。QQ 能力由 [NapCat](https://github.com/NapNeko/NapCatQQ)(OneBot 11)通过模块总线以黑箱工具提供。

## 它的一天

```
醒来 → 翻手机(看会话未读)→ 挑几条回回、有的只标已读 → 有人连环@它,烦躁 → 打发掉
  → 困意渐起(文案注入)→ 自愿去睡,睡前把今天写进日记、合并长期记忆
  → 深夜被@风暴吵醒,赖了两轮床,不耐烦地起来处理 → 继续睡
  → 疲惫恢复到阈值,自然醒(睡够了,神清气爽)→ 新的一天
```

全程没有一次"是否要起床?"式的打断询问 —— 起床、入睡、回消息、贴表情、禁言都是它自己调的工具。

## 快速开始

零密钥体验(faux 剧本 LLM + 假 QQ,5 分钟):

```bash
npm install
npm run mock:onebot                                    # 终端 1:假 OneBot 服务器
WATCHING_BOT_FAUX_LLM=1 WATCHING_BOT_TIMESCALE=300 npm start   # 终端 2:300 倍时间飞驰
```

面板:`http://127.0.0.1:8080` —— Vue 3 管理后台:概览、状态与历史、活动日志、感知注入、**Token 统计**(总/输入/输出/缓存命中/命中率五条折线,支持今天、昨天、7/14/30/90 天与自定义起止日期)、长期记忆、模型热切换、模块与系统。状态数值支持步进、滑块与失焦提交,2 秒轮询只更新展示层,不会覆盖正在输入的内容;日志与记忆摘要自动增量刷新。

> 面板前端是 `src/web/public/` 下的 Vue 3 ESM 应用,`vendor/vue.esm-browser.prod.js` 已内置,不需要 Vite 或其他构建步骤,`npm start` 直接可用。

接真实模型与真实 QQ(docker compose):见 **[docs/deployment.md](docs/deployment.md)**。

## 机制速览

| 机制 | 行为 |
|---|---|
| 无限循环 | orchestrator 唯一决定何时调 LLM;模型做完事调 `wait`/`sleep`,run 自然结束即挂起;空响应指数退避兜底 |
| 混合注入 | 体感→伪造 assistant 内心独白 `<feeling>`;环境事件→`[环境]` 旁白;状态数值永不进提示词(单测保证) |
| 睡眠 | `sleep` 自愿 / 疲惫≥90 强制;入睡先做睡眠期归并(日记+MEMORY.md 索引+周归并),日常压缩复用 pi compaction |
| 唤醒 | 疲惫≤15 自然醒 / 12 模拟时硬上限 / 面板强制(系统行为);闹钟、@风暴打断 → **模型自己决定** `wake_up` 还是赖床;闹钟每 10 模拟分重响且文案升级,赖满 6 次强制拽醒 |
| 闹钟 | `set_alarm`/`cancel_alarm` 工具,模型自己上弦 |
| QQ | 18 个工具:消息读写(未读游标/引用回复/发送节流)、群管理(禁言/定制头衔)、贴表情、表情包库(多模态看图/收藏/命名/发送) |
| judge | 双通道情绪修正:实时(风暴/闹钟触发廉价 LLM 判读)+ 睡眠(归并时 `adjust_mood` 结算),冷却与每日上限双保险 |

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构详解:模块总线契约、核心组件、无限循环 kick 模型、醒睡状态机、judge 与持久化 |
| [docs/deployment.md](docs/deployment.md) | 部署:本地无 QQ 体验 / 本机直连 NapCat / Docker Compose,数据备份、升级、FAQ |
| [docs/configuration.md](docs/configuration.md) | 配置详解:模型接入(pi 网关两条路径)、时间模型、状态动力学与调参建议、全部阈值、环境变量总表 |
| [docs/modules.md](docs/modules.md) | 模块开发指南:BotModule 契约、感知归一化、语义标签、napcat 18 工具表、测试方法 |
| [docs/design-decisions.md](docs/design-decisions.md) | 设计决策记录:为什么这么设计,以及哪些约束不能随手"优化"掉 |

## 目录

```
src/
├── index.ts        # 装配:core + state-manager + bus + modules[]
├── bus/            # 模块总线契约(types)与实现(host)—— 最重要的接口
├── core/           # pi Agent 装配、无限循环、醒睡状态机、timeScale 时钟、注入器、文案表、pi 网关接入
├── state/          # 五维规则引擎(纯函数)、状态管理器、judge
├── modules/
│   ├── napcat/     # 唯一了解 QQ 的地方:OneBot 11 WS client + 18 工具 + 未读游标 + 节流
│   └── builtin/    # 日常生理:咖啡提神与主人每日配给
├── memory/         # 睡眠期长期记忆归并(日记 + MEMORY.md 索引 + 周归并)
├── store/          # SQLite(状态历史/注入/活动日志/睡眠记录/闹钟/事件/token 用量)+ state.json 快照
└── web/            # 管理面板(Express API + Vue 3 页面,无构建步骤)
third_party/napcat  # NapCatQQ 仓库指针(submodule,仅协议/源码参考,不参与构建)
tools/              # mock-onebot-server(假 QQ)、调试脚本
tests/              # 状态引擎/文案安全/模型网关单测
docs/               # 上面的五篇文档
```

## 开发

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest(注意已排除 third_party)
npm run dev            # tsx watch
npm run mock:onebot    # 假 OneBot 服务器(--storm 立即触发@风暴)
```

新增能力 = 写一个 `BotModule` + 注册工厂,核心零改动 —— 见 [docs/modules.md](docs/modules.md)。

## 依赖说明

- **pi**([earendil-works/pi](https://github.com/earendil-works/pi),MIT):agent loop、Context、steering、compaction 纯函数、模型网关(40+ provider 目录)、faux 测试 provider。
- **NapCat**([NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ)):QQ 协议端,官方 Docker 镜像或 shell 版,OneBot 11 WebSocket 对接;仓库以 submodule 指针引用仅供源码参考。
