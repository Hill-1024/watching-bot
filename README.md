<p align="center">
  <img src="docs/assets/icon.svg" width="104" alt="watching-bot" />
</p>

<h1 align="center">watching-bot</h1>

<p align="center">
  <strong>一个自己过日子的拟人 agent</strong><br/>
  <sub>A self-looping persona agent, built on pi.</sub>
</p>

<p align="center">
  <a href="https://github.com/Hill-1024/watching-bot/tree/v0.1.1"><img alt="release" src="https://img.shields.io/github/v/tag/Hill-1024/watching-bot?sort=semver&style=flat-square&label=release&color=d3a05f" /></a>
  <a href="https://github.com/Hill-1024/watching-bot/actions/workflows/docker.yml"><img alt="docker" src="https://github.com/Hill-1024/watching-bot/actions/workflows/docker.yml/badge.svg" /></a>
  <a href="https://github.com/Hill-1024/watching-bot/pkgs/container/watching-bot"><img alt="ghcr" src="https://img.shields.io/badge/ghcr.io-watching--bot-2496ED?style=flat-square&logo=docker&logoColor=white" /></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.19-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" />
</p>

> 它不是在等 prompt。它在过一天。

watching-bot 以 [pi](https://github.com/earendil-works/pi)（`pi-agent-core` + `pi-ai`，库模式）为 agent 内核，外挂一套 **LLM 不可见的五维状态**（疲惫 / 心情 / 烦躁 / 压力 / 社交电量）与 **睡醒调度器**。状态不会作为数字泄露给模型，而是通过「混合注入」变成它自己的体感与外部旁白——所以它会真的困、会烦、会赖床，也会在睡醒之后记得一些事。

QQ 是能力之一，不是核心。NapCat / SnowLuma 通过模块总线以黑箱工具接入，默认 NapCat；两套运行时共享同一套 18 个 QQ 工具、消息库与表情包库，可在面板内热切换。

---

## 一眼看懂

| 维度 | watching-bot 的做法 |
|---|---|
| **存在方式** | 无限循环 + 自驱工具调用；做完事自己 `wait` / `sleep`，系统只在等待、闹钟、感知与心跳兜底时唤醒 |
| **身体** | 五维隐藏状态；数值不进入提示词，只按区间翻译成主观文案 |
| **作息** | 自愿入睡 / 疲惫强制关机 / 闹钟重响 / 赖床 / @风暴与私聊分级唤醒 / 睡眠期记忆归并 |
| **记忆** | 热上下文交给 pi compaction；「睡醒仍该记得」的事实写入 `MEMORY.md` 与日记 |
| **QQ** | NapCat（默认）或 SnowLuma，同一套 18 个工具，OneBot 11 |
| **面板** | Vue 3 管理后台：状态曲线、活动日志、感知注入、Token 统计、长期记忆、模型热切换、QQ 接入选择 |
| **扩展** | 新增能力 = 写一个 `BotModule` 并注册工厂；核心与状态管理零改动 |

## 它的一天

```text
醒来 → 翻手机（看会话未读）→ 挑几条回回、有的只标已读
     → 有人连环 @ 它，烦躁上升 → 打发掉
     → 困意渐起（体感注入）→ 自愿去睡
     → 睡前把今天写进日记，把值得记住的事合并进长期记忆
     → 深夜被 @ 风暴吵醒，赖了两轮床，不耐烦地起来处理
     → 继续睡 → 疲惫恢复，自然醒 → 新的一天
```

没有「是否要起床？」式的弹窗。起床、入睡、回消息、贴表情、禁言，都是它自己调用的工具。

## QQ 接入：NapCat / SnowLuma

| 运行时 | 状态 | 说明 |
|---|---|---|
| **NapCat** | 默认 | OneBot 11；面板 NapCat 卡片显示 WebUI 登录 token，可保存自定义 WebUI 端口并等待运行时重启 |
| **SnowLuma** | 可选 | OneBot 11；复用 NapCat 的 18 个工具实现，能力对齐；与 NapCat 共用消息、未读游标与表情包 |

选择保存在 `data/qq-backend.json`（gitignored），面板「模块与系统 → QQ 接入」内互斥切换，默认 NapCat。切换只停 / 启 agent 侧模块，**不负责启动或停止 QQ 进程**：

- Docker 下 NapCat 由 compose 服务托管，`restart: unless-stopped` 自动重启；
- SnowLuma 需要自己的 OneBot WS（默认 `ws://127.0.0.1:3001`，可用 `SNOWLUMA_URL` 覆盖）。同一个 QQ 号不能同时让两套运行时在线，部署时二选一；
- 本地开发时 NapCat / SnowLuma 是独立进程，面板只负责连接与切换。

## 管理面板

`src/web/public/` 是一个 **零构建步骤** 的 Vue 3 ESM 应用（vendored runtime），`npm start` 直接可用。

- **监控**：概览、五维状态与历史曲线、活动日志、感知注入
- **分析**：Token 统计（总 / 输入 / 输出 / 缓存命中 / 命中率；今天、昨天、7/14/30/90 天与自定义起止日期）、长期记忆
- **配置**：模型热切换（provider / model / key / 推理档位）、QQ 接入、NapCat WebUI token 与端口、builtin 主人称呼 / QQ / 每日咖啡配额
- 2 秒轮询只更新展示层，不覆盖正在输入的内容；日志与记忆摘要增量刷新；刷新面板不会闪登录页

> 模型切换会把新的 `contextWindow` 同步给 agent 的压缩逻辑，而不是继续沿用启动配置里的旧窗口。

## 快速开始

### Docker Compose（推荐）

```bash
cat > .env <<'EOF'
WATCHING_BOT_API_KEY=你的模型key
WATCHING_BOT_PANEL_TOKEN=面板密码
QQ_ACCOUNT=你的QQ号
# NAPCAT_TOKEN=给 OneBot WS 加 token（可选）
# WATCHING_BOT_TIMESCALE=1
EOF

docker compose up -d
```

- 面板：`http://127.0.0.1:8080/?token=<你的面板密码>`
- NapCat WebUI：`http://127.0.0.1:6099`，扫码登录并在「网络配置」里启用 **WebSocket 服务器**，端口 `3001`
- 镜像：`ghcr.io/hill-1024/watching-bot:latest`（amd64 / arm64）。正式镜像只由版本 tag 构建；`latest` 跟随最新 release，当前为 `v0.1.1`

### 本地零密钥体验

不需要真 QQ、不需要模型 key：

```bash
npm install

# 终端 1：假 OneBot 服务器（3001；内置测试图片服务 3002）
npm run mock:onebot

# 终端 2：faux 剧本 LLM + 300 倍模拟时间
WATCHING_BOT_FAUX_LLM=1 WATCHING_BOT_TIMESCALE=300 npm start
```

打开 `http://127.0.0.1:8080`，可以看到状态曲线、活动日志、睡眠归并与完整的消息工具链。部署细节见 **[docs/deployment.md](docs/deployment.md)**。

## 架构

```text
                         ┌──────────────────────────────┐
                         │  Vue 3 管理面板 / Express API │
                         └──────────────┬───────────────┘
                                        │ 命令 / 快照 / 日志
┌──────────────────────┐      events      ┌─────────────────────────────┐
│ StateManager         │ ◄──────────────► │ AgentCore                   │
│ 五维隐藏状态 + judge  │                  │ pi Agent + 无限循环          │
└──────────────────────┘                  │ 睡醒状态机 + clock + injector │
                                          └──────────────┬──────────────┘
                                                         │ 唯一边界：ModuleBus
                              ┌──────────────────────────┼──────────────────────────┐
                              │                          │                          │
                         ┌────▼────┐                ┌────▼─────┐              ┌─────▼────┐
                         │ napcat  │                │ snowluma │              │ builtin  │
                         │ OneBot  │                │ OneBot   │              │ 咖啡/生理 │
                         └─────────┘                └──────────┘              └──────────┘
```

依赖方向是一条约不动的线：**`modules → bus ← core ← state-manager`**。核心不 import 任何具体模块，状态管理器不认识 QQ；模块之间互不相识。

## 机制速览

| 机制 | 行为 |
|---|---|
| 无限循环 | orchestrator 唯一决定何时调 LLM；模型自己 `wait` / `sleep`，run 结束即挂起；空响应指数退避 |
| 混合注入 | 体感 → 伪造 assistant 内心独白 `<feeling>`；环境 → `[环境]` 旁白；状态数值永不进入提示词 |
| 睡眠 | 自愿 `sleep` / 疲惫 ≥ 90 强制；入睡先做睡眠期归并（日记 + `MEMORY.md` + 周记），日常压缩复用 pi compaction |
| 唤醒 | 自然醒 / 硬上限 / 面板强制；闹钟与 @ 风暴 → 模型自己决定 `wake_up` 还是赖床；赖满 6 次强制拽醒 |
| 闹钟 | `set_alarm` / `cancel_alarm`，模型自己上弦 |
| QQ | 18 个工具：消息读写、未读游标、引用回复、发送节流、群管理、贴表情、表情包库与多模态看图 |
| judge | 双通道情绪修正：实时（风暴 / 闹钟）+ 睡眠结算，冷却与每日上限双保险 |
| 模型 | pi 网关 40+ provider；面板热切换；agent 压缩窗口跟随当前模型的实际 `contextWindow` |

## 目录

```text
src/
├── index.ts              # 装配：core + state-manager + bus + modules
├── qq-backend.ts         # NapCat / SnowLuma 选择与持久化
├── bus/                  # 模块总线契约与实现（最重要的接口）
├── core/                 # pi Agent、无限循环、睡醒状态机、时钟、注入、模型网关
├── state/                # 五维规则引擎、状态管理器、judge
├── modules/
│   ├── napcat/           # OneBot 11 客户端 + 18 工具 + 未读游标 + WebUI 配置
│   ├── snowluma/         # 第二套 OneBot 运行时，复用同一套工具
│   └── builtin/          # 咖啡提神、主人配给与运行时配置
├── memory/               # 睡眠期长期记忆归并
├── store/                # SQLite + state.json 快照
└── web/                  # Express API + Vue 3 页面（无构建步骤）

docs/assets/icon.svg      # README 品牌 icon
tests/                    # 状态、用量、QQ 后端、SnowLuma 工具对齐、存储
tools/                    # mock-onebot、调试脚本
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构、模块总线、无限循环、睡醒状态机、持久化 |
| [docs/configuration.md](docs/configuration.md) | 模型接入、时间与状态、QQ 双运行时、环境变量 |
| [docs/deployment.md](docs/deployment.md) | 本地体验、直连 NapCat、Docker Compose、备份与 FAQ |
| [docs/modules.md](docs/modules.md) | `BotModule` 契约、感知归一化、18 工具、扩展方式 |
| [docs/design-decisions.md](docs/design-decisions.md) | 关键设计约束与取舍 |

## 开发

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run dev            # tsx watch
npm run mock:onebot    # 假 OneBot（--storm 立即触发 @ 风暴）
```

新增能力 = 写一个 `BotModule` + 注册工厂，核心零改动。见 [docs/modules.md](docs/modules.md)。

## 数据与安全

- `data/` 已 gitignore：`state.json`、长期记忆、模块消息库、表情包、`model.json`、`builtin.json`、`qq-backend.json` 都在这里；
- API key、面板 token、NapCat / SnowLuma token 不进仓库；`data/` 与 `runtime/` 也被 `.dockerignore` 排除；
- 备份 = 拷走整个 `data/`；NapCat 登录态在 compose 的 `napcat-data` 卷里；
- 面板 token 通过 `WATCHING_BOT_PANEL_TOKEN` 设置，支持 `?token=` 登录并自动清洗地址栏。

## Credits

- [pi](https://github.com/earendil-works/pi) — agent loop、上下文、compaction、模型网关
- [NapCat](https://github.com/NapNeko/NapCatQQ) — QQ 协议端（默认）
- [SnowLuma](https://github.com/SnowLuma/SnowLuma) — 第二套 OneBot 11 运行时（可选）
- [Vue](https://vuejs.org/) — 管理面板

watching-bot 与腾讯 / QQ 官方无关。QQ 相关运行时请遵守各自项目许可与平台规则。

<p align="center">
  <sub>watching-bot · v0.1.1 · built on pi</sub>
</p>
