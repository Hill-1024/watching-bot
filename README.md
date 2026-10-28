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
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.19-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4B5563?style=flat-square" />
</p>

> 它不是在等 prompt。它在过一天。

watching-bot 以 [pi](https://github.com/earendil-works/pi)（`pi-agent-core` + `pi-ai`，库模式）为 agent 内核，外挂一套 **LLM 不可见的五维状态**（疲惫 / 心情 / 烦躁 / 压力 / 社交电量）与 **睡醒调度器**。状态不会作为数字泄露给模型，而是通过「混合注入」变成它自己的体感与外部旁白——所以它会真的困、会烦、会赖床，也会在睡醒之后记得一些事。

QQ 是能力之一，不是核心。它是一个插件，内部再选 NapCat 或 SnowLuma 之一作为 runtime；两套运行时共享同一份 OneBot 11 实现、21 个工具、消息库与表情包库，可在 QQ 页面里切换。机器人和 QQ 协议端都以普通 Node / 本机进程运行，没有 Docker、没有容器编排。

---

## 一眼看懂

| 维度 | watching-bot 的做法 |
|---|---|
| **存在方式** | 无限循环 + 自驱工具调用；做完事自己 `wait` / `sleep`，系统只在等待、闹钟、感知与心跳兜底时唤醒 |
| **身体** | 五维隐藏状态；数值不进入提示词，只按区间翻译成主观文案 |
| **作息** | 自愿入睡 / 疲惫强制关机 / 闹钟重响 / 赖床 / @风暴与私聊分级唤醒 / 睡眠期记忆归并 |
| **记忆** | 热上下文交给 pi compaction；「睡醒仍该记得」的事实写入 `MEMORY.md` 与日记 |
| **QQ** | 一个 QQ 插件，NapCat / SnowLuma 二选一 runtime；同一套 21 个工具与数据 |
| **面板** | Vue 3 管理后台：状态曲线、活动日志、感知注入、Token 统计、长期记忆、模型热切换、每插件独立页面；数据由 SSE 事件驱动，不轮询 |
| **扩展** | 新增能力 = 在 `plugins/<id>/` 放一个 `module.json` + 服务端入口；核心、主路由与导航零改动 |

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
| **NapCat** | 默认 | OneBot 11；面板读取本地 `webui.json` 显示 WebUI token |
| **SnowLuma** | 可选 | OneBot 11；复用 NapCat 的 21 个工具实现，能力对齐；与 NapCat 共用消息、未读游标与表情包 |

选择保存在 `data/qq-backend.json`（gitignored），面板「模块与系统 → QQ 接入」内互斥切换，默认 NapCat。切换只断/连 agent 侧连接，**不负责启动或停止 QQ 进程**：

- NapCat / SnowLuma 都以独立进程跑在本机，面板只负责连接与切换；
- 默认 OneBot 地址是 `ws://127.0.0.1:3001`，可用 `NAPCAT_URL` / `SNOWLUMA_URL` 或 `moduleConfig` 覆盖；
- 同一个 QQ 号不能同时让两套运行时在线，部署时二选一。

开机自启只有主框架一个入口。框架里的 `runtime` 插件读 `data/runtime.json`，按顺序唤醒 QQ、SnowLuma 等本机组件：

```json
{"components":[
  {"id":"qq","command":"runtime/qq/Files/QQ.exe","cwd":"runtime/qq/Files","check":{"process":"QQ.exe"}},
  {"id":"snowluma","command":"runtime/snowluma/node.exe","args":["index.mjs"],
   "cwd":"runtime/snowluma","check":{"port":5099},"delayMs":3000}
]}
```

已经在跑的外部进程会被接管、不重复拉起；进程退出后下一轮检查会重新唤醒。框架停止时组件随进程树结束，下次启动由 `runtime` 插件重新拉起；QQ / SnowLuma 的数据与登录态在各自目录保留，通常无需重新扫码。

## 联网搜索与 MCP

builtin 插件除了咖啡，还提供 **`web_search`**（DeepSeek 官方搜索端点 `/v1/tools/search` 或 SearXNG `format=json`），以及宿主能力 **`read_file` / `write_file` / `list_files` / `run_shell`**。宿主工具默认锁在项目工作目录内，`.env` 与 `.git` 拒绝访问，shell 带超时与输出上限，可在面板 Builtin 页关闭。

浏览器、桌面等外部能力走标准 MCP：框架新增 `plugins/mcp`，作为 MCP 客户端连接外部 server（stdio 或 SSE），把 server 的 tools 原样暴露给 agent。**代码里没有任何 OBU / OCU 专用逻辑**：

- **OBU**（Open Browser Use）提供 `obu mcp`，管浏览器标签页与 CDP；
- **OCU**（Open Computer Use）提供 `ocu mcp`，管整台桌面（键鼠、截图、窗口）。

```bash
# 宿主机安装
npm i -g open-browser-use && open-browser-use setup   # OBU
npm i -g @opensymph/open-computer-use                 # OCU,命令是 ocu
```

```json
// bot 直接跑在宿主机:data/mcp.json 用 stdio,无需网关
{"servers":[
  {"id":"obu","transport":"stdio","command":"obu","args":["mcp"],"shell":true,"toolPrefix":"obu_"},
  {"id":"ocu","transport":"stdio","command":"ocu","args":["mcp"],"shell":true,"toolPrefix":"ocu_"}
]}
```

MCP 工具会以 `obu_*` / `ocu_*` 出现在 agent 的工具列表里（`obu_open_tab`、`obu_cdp`、`ocu_screenshot`、`ocu_click` 等，具体由对应 server 决定）。本机 stdio 模式下，MCP 进程在每次工具调用前按需拉起，断了自动重连。如果某个 server 只提供 SSE（例如跑在另一台机器），把 `transport` 改成 `sse` 并填 `url` / `headers` 即可。面板「Builtin」页只负责搜索与宿主能力配置；MCP 的 server 列表在 `data/mcp.json`。

## 管理面板

`src/web/public/` 是一个 **零构建步骤** 的 Vue 3 ESM 应用（vendored runtime），`npm start` 直接可用。

- **监控**：概览、五维状态与历史曲线、活动日志、感知注入
- **分析**：Token 统计（总 / 输入 / 输出 / 缓存命中 / 命中率；今天、昨天、7/14/30/90 天与自定义起止日期）、长期记忆
- **配置**：模型热切换（provider / model / key / 推理档位）、QQ 接入、NapCat WebUI token、builtin 主人称呼 / QQ / 每日咖啡配额 / 联网搜索 / 宿主能力开关
- 2 秒轮询只更新展示层，不覆盖正在输入的内容；日志与记忆摘要增量刷新；刷新面板不会闪登录页

> 模型切换会把新的 `contextWindow` 同步给 agent 的压缩逻辑，而不是继续沿用启动配置里的旧窗口。

## 快速开始

### 桌面应用（Electron Release，推荐日常使用）

从 [GitHub Releases](https://github.com/Hill-1024/watching-bot/releases) 下载对应平台安装包：

- Windows：`watching-bot-setup-*-x64.exe`（NSIS 安装）或 `watching-bot-portable-*-x64.exe`
- Linux：`watching-bot-*-x64.AppImage` / `.deb`
- macOS：`watching-bot-*-arm64.dmg` / `.zip`（未签名，首次需右键打开）

Electron 壳的行为：

- **壳内 Dashboard 不需要登录 token**：每次启动生成 loopback token，窗口自动带 token 打开，随后地址栏会被面板清掉；
- **壳外浏览器访问需要 token**：托盘菜单「复制壳外访问地址(含 token)」/「显示 WebUI token」；
- **唯一的开机自启入口**：首次运行注册为登录自启（之后可在托盘勾选/取消），QQ / SnowLuma 仍由框架里的 `runtime` 插件唤醒；
- 数据在系统用户目录（Windows `%APPDATA%\watching-bot`），不写安装目录；
- 托盘提供打开面板、重新加载、重启后台、打开数据目录、退出。

> Electron 版和下面的 WebUI-only 版**二选一**，不要同时运行两个后端（会抢同一套 QQ 运行时）。

### WebUI-only 一键安装（推荐长期挂机 / 无桌面环境）

前置：Node.js ≥ 22.19；Windows / Linux / macOS 均可。

远程一键（会先克隆/更新仓库到 `~/.watching-bot` 或 `%LOCALAPPDATA%\watching-bot\src`）：

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/Hill-1024/watching-bot/main/scripts/install-remote.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/Hill-1024/watching-bot/main/scripts/install-remote.ps1 | iex
```

也可以在仓库根目录直接跑：

```powershell
# Windows(双击 scripts\install.cmd 也可以)
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# 想直接带 key:
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -ApiKey sk-... -PanelToken 你的面板密码
```

```bash
# Linux / macOS
bash scripts/install.sh
# 或: bash scripts/install.sh --api-key sk-... --panel-token 你的面板密码
```

脚本会：检查 Node → `npm ci --omit=dev --ignore-scripts` → 从 `.env.example` 生成 `.env`、自动生成面板 token → 创建 `data/` → 注册登录自启服务并启动：

- Windows：计划任务 `watching-bot`（登录时启动，崩溃 5 秒后自动重启）。**开机自启只有这一个入口**；QQ / SnowLuma 由框架里的 `runtime` 插件按 `data/runtime.json` 唤醒
- Linux：systemd user 服务 `watching-bot`（并尝试开启 linger）
- macOS：launchd `com.watching-bot`

面板：`http://127.0.0.1:9981/?token=<你的面板密码>`。

卸载（默认保留 `data/`、`config/`、`.env`）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1          # 加 -Purge 连数据一起删
```

```bash
bash scripts/uninstall.sh                                               # 加 --purge 连数据一起删
```

QQ 运行时（NapCat / SnowLuma）不在安装脚本里：从各自官方发布页下载，作为本机进程启动，在它的 WebUI 里启用 **OneBot v11 WebSocket 服务器**（默认端口 `3001`）。NapCat WebUI 默认在 `http://127.0.0.1:6099`。详见 [docs/deployment.md](docs/deployment.md)。

### 本地零密钥体验

不需要真 QQ、不需要模型 key：

```bash
npm install --ignore-scripts

# 终端 1：假 OneBot 服务器（3001；内置测试图片服务 3002）
npm run mock:onebot

# 终端 2：faux 剧本 LLM + 300 倍模拟时间
WATCHING_BOT_FAUX_LLM=1 WATCHING_BOT_TIMESCALE=300 npm start
```

打开 `http://127.0.0.1:9981`，可以看到状态曲线、活动日志、睡眠归并与完整的消息工具链。部署细节见 **[docs/deployment.md](docs/deployment.md)**。

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
                         │ OneBot  │                │ OneBot   │              │咖啡/搜索 │
                         └─────────┘                └──────────┘              └──────────┘
```

> 外部能力走标准 MCP:`plugins/mcp` 作为客户端连接 `data/mcp.json` 里配置的 MCP server(stdio / SSE),把 server 的 tools 原样接给 agent;OBU(`obu mcp`)和 OCU(`ocu mcp`)都只是普通 server。

依赖方向是一条约不动的线：**`modules → bus ← core ← state-manager`**。核心不 import 任何具体模块，状态管理器不认识 QQ；模块之间互不相识。

## 机制速览

| 机制 | 行为 |
|---|---|
| 无限循环 | orchestrator 唯一决定何时调 LLM；模型自己 `wait` / `sleep`，run 结束即挂起；空响应指数退避 |
| 混合注入 | 体感 → 伪造 assistant 内心独白 `<feeling>`；环境 → `[环境]` 旁白；状态数值永不进入提示词 |
| 睡眠 | 自愿 `sleep` / 疲惫 ≥ 90 强制；入睡先做睡眠期归并（日记 + `MEMORY.md` + 周记），日常压缩复用 pi compaction |
| 唤醒 | 自然醒 / 硬上限 / 面板强制；闹钟与 @ 风暴 → 模型自己决定 `wake_up` 还是赖床；赖满 6 次强制拽醒 |
| 闹钟 | `set_alarm` / `cancel_alarm`，模型自己上弦 |
| QQ | 21 个工具：消息读写、未读游标、引用回复、图片/文件发送、发送节流、群管理、贴表情、表情包库与多模态看图 |
| 搜索 | `web_search`（DeepSeek / SearXNG） |
| 宿主能力 | `read_file` / `write_file` / `list_files` / `run_shell`（工作目录约束、输出上限，可关闭） |
| 本机组件 | `runtime` 插件按 `data/runtime.json` 唤醒 QQ / SnowLuma，做存活检查与自动重启；开机只启动主框架 |
| MCP | `plugins/mcp` 标准 MCP 客户端(stdio / SSE);OBU / OCU 以 `obu_*` / `ocu_*` 暴露 |
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
├── memory/               # 睡眠期长期记忆归并
├── store/                # SQLite + state.json 快照
└── web/                  # Express API + Vue 3 页面（无构建步骤）

plugins/
├── builtin/              # 咖啡、联网搜索、宿主能力
├── mcp/                  # 标准 MCP 客户端:stdio / SSE,把外部 tools 接给 agent
├── qq/                   # OneBot 11 客户端 + 21 工具 + NapCat/SnowLuma 选择
└── runtime/              # 本机组件运行时:唤醒/探测/重启 QQ、SnowLuma

electron/                 # Electron 主进程 / 加载页(sidecar 托管、托盘、自启、token)
build/                    # Electron 图标源(icon.png/ico/icns、icons/)
scripts/                  # 一键安装/卸载/服务化 + Electron 打包脚本
docs/assets/icon.svg      # README 品牌 icon
tests/                    # 状态、用量、QQ、搜索、MCP、宿主工具、存储
tools/                    # mock-onebot、调试脚本
```

## 文档

| 文档 | 内容 |
|---|---|
| [docs/architecture.md](docs/architecture.md) | 架构、模块总线、无限循环、睡醒状态机、持久化 |
| [docs/configuration.md](docs/configuration.md) | 模型接入、时间与状态、QQ 双运行时、环境变量 |
| [docs/deployment.md](docs/deployment.md) | 一键安装/卸载、服务化、原生 NapCat / SnowLuma、备份与 FAQ |
| [docs/modules.md](docs/modules.md) | `BotModule` 契约、感知归一化、21 工具、扩展方式 |
| [docs/design-decisions.md](docs/design-decisions.md) | 关键设计约束与取舍 |

## 开发

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest
npm run dev            # node --watch
npm run mock:onebot    # 假 OneBot（--storm 立即触发 @ 风暴）

npm run dev:desktop    # Electron dev:仓库数据 + 系统 Node,不注册自启/服务
npm run electron       # Electron 壳(开发模式,后端用系统 Node)
npm run icons          # 从 docs/assets/icon.svg 生成 build/icon.{png,ico,icns}
npm run dist:win       # 下载 Node 运行时 + 准备 server payload + 打 Windows 包
npm run dist:linux     # Linux AppImage / deb
npm run dist:mac       # macOS dmg / zip
```

`npm run dev:desktop` 会直接使用仓库的 `data/`、`config/`、`persona/`、`.env`，默认 token `develectron123`，DevTools 端口 `9225`；因为 `app.isPackaged=false`，不会注册开机自启或系统服务，适合本地调试。

Release 由 `.github/workflows/release.yml` 在 `v*` tag 上构建 Windows / Linux / macOS(x64+arm64) 并上传到 GitHub Release。Electron 主进程只负责窗口/托盘/自启/后台进程托管，业务代码仍由 `resources/server` 里的原 Node 后端执行。

新增能力 = 写一个 `BotModule` + 注册工厂，核心零改动。见 [docs/modules.md](docs/modules.md)。

## 数据与安全

- `data/` 已 gitignore：`state.json`、长期记忆、模块消息库、表情包、`model.json`、`builtin.json`、`qq-backend.json` 都在这里；
- API key、面板 token、NapCat / SnowLuma token 不进仓库；`.env`、`data/`、`runtime/` 都在 `.gitignore` 里；
- 备份 = 拷走整个 `data/`；NapCat 登录态在它自己的安装目录（`runtime/` 或你指定的位置）；
- 桌面版的数据在 Electron 用户目录（Windows `%APPDATA%\watching-bot`），备份/迁移时拷走这个目录；
- 面板 token 通过 `WATCHING_BOT_PANEL_TOKEN` 设置，支持 `?token=` 登录并自动清洗地址栏；
- 宿主能力（`run_shell`）等于把机器交给模型执行命令：只接入可信的 QQ 会话，担心提示注入就把 `hostTools.shellEnabled` 关掉。

## Credits

- [pi](https://github.com/earendil-works/pi) — agent loop、上下文、compaction、模型网关
- [NapCat](https://github.com/NapNeko/NapCatQQ) — QQ 协议端（默认）
- [SnowLuma](https://github.com/SnowLuma/SnowLuma) — 第二套 OneBot 11 运行时（可选）
- [Vue](https://vuejs.org/) — 管理面板

watching-bot 与腾讯 / QQ 官方无关。QQ 相关运行时请遵守各自项目许可与平台规则。

<p align="center">
  <sub>watching-bot · v0.1.1 · built on pi</sub>
</p>
