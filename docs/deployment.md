# 部署指南

watching-bot 有两种安装形态:**桌面应用(Electron)** 和 **WebUI-only(Node 服务)**。两者底层是同一个 Node 后端,二选一,不要同时运行两个后端(会抢同一套 QQ 运行时)。没有 Docker、没有容器编排、没有 supervisor。

前置依赖:Node.js ≥ 22.19(WebUI-only 需要)、一个 GitHub 可达的网络(装依赖/下载 QQ 运行时用)。QQ 协议端 NapCat / SnowLuma 是可选的独立进程。

## 方式一:桌面应用(Electron Release)

从 [GitHub Releases](https://github.com/Hill-1024/watching-bot/releases) 下载:

- Windows:`watching-bot-setup-*-x64.exe` 或 `watching-bot-portable-*-x64.exe`
- Linux:`watching-bot-*-x64.AppImage` / `.deb`
- macOS:`watching-bot-*-{x64,arm64}.dmg` / `.zip`(未签名,首次右键打开)

壳的行为:

- 后端由打包内的 Node 运行时执行,监听 `127.0.0.1` 的随机空闲端口;
- 每次启动生成随机 panel token,壳内窗口自动带 token 打开 Dashboard,所以**壳内不用登录**;
- 同一个 token 可通过托盘「复制壳外访问地址(含 token)」拿到,壳外浏览器打开 WebUI 必须带它;
- 首次运行默认注册为登录自启(托盘可取消),系统里**只有 Electron 一个自启入口**;
- 托盘:打开面板、重新加载、重启后台、复制访问地址、显示 token、打开数据目录、开机自启、退出;
- 用户数据在系统用户目录(Windows `%APPDATA%\watching-bot`),包含 `config/`、`persona/`、`data/`、`.env`、`logs/desktop.log`。

构建(开发机需要 Node ≥ 22.19):

```bash
npm ci --ignore-scripts
npm run electron        # 开发模式,后端用系统 Node
npm run dist:win        # Windows NSIS + portable
npm run dist:linux      # Linux AppImage + deb
npm run dist:mac        # macOS dmg + zip
```

`dist:*` 会自动下载目标平台 Node 运行时、准备 `build/server` 生产依赖,再交给 electron-builder。正式 Release 由 `.github/workflows/release.yml` 在 `v*` tag 上构建并上传。

网络慢时可指定镜像:

```bash
NODE_RUNTIME_MIRROR=https://npmmirror.com/mirrors/node \
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist:win
```

> 本地 Windows 如果开了 Application Control / Smart App Control,无签名的 NSIS 安装器可能被系统拦截;CI 构建不受影响。需要分发给普通用户时建议配置代码签名。

## 方式二:WebUI-only 一键安装(推荐长期挂机)

### 远程一键(不先 clone)

```bash
# Linux / macOS:克隆/更新到 ~/.watching-bot 后安装
curl -fsSL https://raw.githubusercontent.com/Hill-1024/watching-bot/main/scripts/install-remote.sh | bash
```

```powershell
# Windows:克隆/更新到 %LOCALAPPDATA%\watching-bot\src 后安装
irm https://raw.githubusercontent.com/Hill-1024/watching-bot/main/scripts/install-remote.ps1 | iex
```

### Windows(仓库内)

```powershell
# 在仓库根目录
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
# 也可以双击 scripts\install.cmd

# 带参数:
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -ApiKey sk-... -PanelToken 你的面板密码
```

脚本会:

1. 检查 Node ≥ 22.19;
2. `npm ci --omit=dev --ignore-scripts`(没有 lockfile 时 `npm install --omit=dev --ignore-scripts`);
3. 从 `.env.example` 生成 `.env`,缺面板 token 时自动生成随机值;
4. 创建 `data/`、`data/memories`、`data/modules`、`data/plugins`;
5. 注册计划任务 `watching-bot`(当前用户登录时启动,隐藏窗口);
6. 启动服务。

计划任务由 `scripts/service-run.ps1` 托管:进程退出后 5 秒自动重启,日志追加到 `data/service.log`,PID 写到 `data/service.pid`。

**开机自启只有 `watching-bot` 一个入口。** QQ、SnowLuma 等本机组件不在系统里单独注册,而由框架里的 `runtime` 插件按 `data/runtime.json` 唤醒:

```json
{
  "ensureIntervalMs": 15000,
  "components": [
    {
      "id": "qq",
      "command": "runtime/qq/Files/QQ.exe",
      "cwd": "runtime/qq/Files",
      "check": { "process": "QQ.exe" }
    },
    {
      "id": "snowluma",
      "command": "runtime/snowluma/node.exe",
      "args": ["index.mjs"],
      "cwd": "runtime/snowluma",
      "check": { "port": 5099 },
      "delayMs": 3000
    }
  ]
}
```

- 已经在运行的外部进程会被接管,不会重复拉起;
- 进程退出后,下一轮 `ensureIntervalMs` 检查会重新唤醒;
- 组件按数组顺序启动,`delayMs` 给前置组件留启动时间;
- 框架停止时组件随服务进程树结束,下次启动由插件重新唤醒;QQ / SnowLuma 的登录态与数据在 `runtime/` 下保留;
- 状态与手动唤醒:`GET/POST /api/plugins/runtime/actions/`。

```powershell
Start-ScheduledTask  -TaskName watching-bot
Stop-ScheduledTask   -TaskName watching-bot
Get-Content data\service.log -Wait
```

### Linux / macOS

```bash
bash scripts/install.sh
# 或:
bash scripts/install.sh --api-key sk-... --panel-token 你的面板密码
```

- Linux:安装 systemd **user** 服务 `watching-bot`,并尝试 `loginctl enable-linger`,让你注销后仍继续运行;
- macOS:安装 launchd `com.watching-bot`(`~/Library/LaunchAgents/com.watching-bot.plist`);
- 其他环境:跳过服务安装,提示用 `npm start` 前台运行。

```bash
# Linux
systemctl --user status watching-bot
systemctl --user restart watching-bot
tail -f data/service.log

# macOS
launchctl kickstart -k gui/$(id -u)/com.watching-bot
tail -f data/service.log
```

安装完成后面板地址:

```text
http://127.0.0.1:9981/?token=<WATCHING_BOT_PANEL_TOKEN>
```

### 卸载

默认保留 `data/`(记忆、消息库、表情包)、`config/` 与 `.env`;只有显式 purge 才删这些:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1          # 保留数据
powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 -Purge   # 连 node_modules/data/.env 一起删
```

```bash
bash scripts/uninstall.sh          # 保留数据
bash scripts/uninstall.sh --purge  # 连 node_modules/data/.env 一起删
```

卸载脚本只停/删 `watching-bot` 自启入口。由 `runtime` 插件拉起的 QQ / SnowLuma 默认不会被强杀(它们的登录态与数据在 `runtime/` 下),需要时手动关闭 QQ 窗口或结束对应进程。

## 方式三:手动运行 / 开发

```bash
npm ci --ignore-scripts     # better-sqlite3 自带预编译二进制,不需要 node-gyp
cp .env.example .env        # 填 WATCHING_BOT_API_KEY
npm start                   # 自动加载 .env,tsx 直跑 TypeScript

npm run dev:desktop         # Electron dev:仓库 data/ + 系统 Node,不注册服务/自启
```

`npm start` 使用 `node --env-file-if-exists=.env --import tsx src/index.ts`,不需要编译步骤。开发时用:

```bash
npm run dev                 # node --watch
npm run typecheck
npm test
```

### 本地零密钥体验

不需要真 QQ、不需要模型 key:

```bash
npm install

# 终端 1:假 OneBot 服务器(3001;内置测试图片服务 3002)
npm run mock:onebot

# 终端 2:faux 剧本 LLM + 300 倍模拟时间
WATCHING_BOT_FAUX_LLM=1 WATCHING_BOT_TIMESCALE=300 npm start
```

打开 `http://127.0.0.1:9981`(未设 token 则免鉴权),可以看到状态曲线、活动日志、睡眠归并与完整的消息工具链。Windows PowerShell 设置环境变量用 `$env:WATCHING_BOT_FAUX_LLM=1`。

## QQ 运行时:NapCat / SnowLuma

QQ 协议端不是 bot 的子进程,安装脚本也不会替你下载它。两者都作为**本机独立进程**运行,bot 只连它们的 OneBot v11 WebSocket。

### NapCat(默认)

1. 从 [NapNeko/NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 `NapCat.Shell.zip`,解压到例如 `runtime/napcat-node`;
2. 运行 `launcher.bat`(Windows)或 `launcher.sh`(Linux),扫码登录 QQ;
3. 打开 NapCat WebUI(默认 `http://127.0.0.1:6099`)→ 网络配置 → 新建 → **WebSocket 服务器**,端口 `3001`,token 可选;
4. bot 默认连接 `ws://127.0.0.1:3001`。端口或地址不同就用 `NAPCAT_URL` / `moduleConfig.qq.napcatUrl` 覆盖;
5. 打开面板「模块与系统 → QQ 接入」,连接状态应变成 `connected`。

面板会读取 `NAPCAT_WEBUI_CONFIG` 指向的 `webui.json`(默认 `runtime/napcat-node/napcat/config/webui.json`)来展示 WebUI token;也可以用 `NAPCAT_WEBUI_TOKEN` 直接提供。

### SnowLuma(可选)

1. 从 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases) 下载 `win-x64` 包,解压到 `runtime/snowluma`(应能看到 `node.exe`、`index.mjs`、`launcher.bat`);
2. 先启动 Windows 桌面 QQ(NTQQ),再启动 SnowLuma(`launcher.bat`,或 `node.exe index.mjs`);SnowLuma 会注入本机的 `QQ.exe`,在 QQ 窗口里扫码登录;
3. 配置 OneBot **WebSocket 服务器**,监听 `127.0.0.1:3001`;账号配置在 `runtime/snowluma/config/onebot_<uin>.json`;
4. 需要 token 时,把 WS 的 `accessToken` 写进 `.env` 的 `SNOWLUMA_TOKEN`(或面板 QQ 页手填);
5. 在面板「模块与系统 → QQ 接入」切换到 SnowLuma。选择写入 `data/qq-backend.json`,重启后保持;
6. 把 SnowLuma 写进 `data/runtime.json` 的 `components`(参考上面的示例),由 `runtime` 插件在开机时唤醒;不需要再注册独立计划任务。

从 Docker 迁移时,可把容器里的 `/app/data/config` 与 `/app/data/data` 复制到 `runtime/snowluma/config` 与 `runtime/snowluma/data`;QQ 登录态在容器里,原生端需要重新扫码。

两套运行时共用 `data/modules/napcat.db` 与 `data/modules/memes`。同一个 QQ 号不能同时让 NapCat 和 SnowLuma 在线,切换前停掉另一个运行时。面板只切换 bot 侧连接,不启动/停止 QQ 进程。

## 数据与备份

| 数据 | 位置 | 说明 |
|---|---|---|
| bot 状态/记忆/消息/表情包 | `./data` | SQLite + state.json + MEMORY.md + memories/ + modules/;备份 = 拷走这个目录 |
| 配置 | `./config/default.json` | 仓库跟踪;本地改动请记录 |
| 密钥 | `./.env` | gitignored |
| NapCat 登录态 | NapCat 自己的安装目录 | 例如 `runtime/napcat-node`;重启进程不用重新扫码 |

桌面版的上述内容都在 Electron 用户数据目录(Windows `%APPDATA%\watching-bot`,macOS `~/Library/Application Support/watching-bot`,Linux `~/.config/watching-bot`)。备份桌面版 = 拷走这个目录。

## 升级

桌面版:下载新 release 覆盖安装即可,用户数据目录不会被动。

WebUI-only:

```bash
git pull
npm ci --omit=dev --ignore-scripts
# Windows
Stop-ScheduledTask watching-bot; Start-ScheduledTask watching-bot
# Linux
systemctl --user restart watching-bot
# macOS
launchctl kickstart -k gui/$(id -u)/com.watching-bot
```

`data/` 不会被升级覆盖。版本回退 = `git checkout <tag>` + `npm ci` + 重启。

## 联网搜索

`web_search` 支持 DeepSeek 官方搜索端点或 SearXNG。SearXNG 要在 `settings.yml` 里启用 JSON:

```yaml
search:
  formats:
    - html
    - json
```

本机直跑直接写回环地址:

```bash
# .env
WATCHING_BOT_SEARXNG_URL=http://127.0.0.1:10099
# 或直接用 DeepSeek 官方搜索端点
DEEPSEEK_API_KEY=sk-...
```

也可以启动后在面板「Builtin → 联网搜索」里填,保存到 `data/builtin.json`(gitignored)。

## 标准 MCP:OBU 浏览器 / OCU 桌面控制

OBU 提供 `obu mcp`,OCU(Open Computer Use)提供 `ocu mcp`,两者都是标准 MCP stdio server。框架的 `plugins/mcp` 作为标准 MCP 客户端接入,**没有 OBU / OCU 专用桥接代码**。

1. **本机安装**:

   ```bash
   # OBU:Chrome/Edge 扩展 + native host
   npm i -g open-browser-use
   open-browser-use setup
   open-browser-use ping        # 返回 pong 才算通

   # OCU:整台桌面(键鼠、截图、窗口)
   npm i -g @opensymph/open-computer-use
   ocu mcp                      # 能起来就说明 stdio server 可用
   ```

2. **配置 `data/mcp.json`**(gitignored):

   ```json
   {"servers":[
     {"id":"obu","transport":"stdio","command":"obu","args":["mcp"],"shell":true,"toolPrefix":"obu_"},
     {"id":"ocu","transport":"stdio","command":"ocu","args":["mcp"],"shell":true,"toolPrefix":"ocu_"}
   ]}
   ```

   如果某个 server 只提供 SSE(例如跑在另一台机器),把该条改成 `{"transport":"sse","url":"http://host:port/sse","headers":{...}}` 即可,不需要网关进程。

3. **验证**:日志出现 `已启动 mcp (工具: obu_ping, ocu_screenshot, ...)`;或 `GET /api/plugins/mcp/actions/` 看到 `obu` / `ocu` ready 与工具列表。

4. **启用/停用**:把对应 server 的 `enabled` 设为 `true` / `false`,或在 `data/mcp.json` 里删掉;改完重启 bot 或重新加载 `mcp` 插件。

> **安全边界**:OBU 等于「谁连上谁就能驱动你浏览器」,OCU 更等于「谁连上谁就能操作你整台电脑」(键鼠、截图、开程序)。只在本机可信环境使用。

## 模拟时间与真实时间

`time.syncOnResume`(默认 `true`)在 `timeScale=1` 时把重启后的模拟钟对齐真实时间:机器关机期间模拟时间不会前进,不校正的话「它的一天」会永久落后(例如停机 24 小时,它就一直在过昨天)。允许的偏差由 `time.maxResumeDriftSimMinutes`(默认 10 分钟)控制,校正时会打一行日志说明偏差多少小时。`timeScale > 1` 的加速测试模式不做校正。

## 环境变量

见 `docs/configuration.md` 末尾的总表。

## 常见问题

**Q: 日志里反复「连接断开,Ns 后重连」**
NapCat / SnowLuma 侧 WS 服务器没建好、端口不对或 token 不匹配。确认它的 WebUI 里建的是「WebSocket **服务器**」且端口是 3001;bot 重连是自动的,修好配置即可。

**Q: 面板切到 SnowLuma 后没有反应**
面板只切换 bot 侧连接;SnowLuma 的 OneBot WS 需要已经在 `SNOWLUMA_URL` / `moduleConfig.qq.snowlumaUrl` 上监听。确认 SnowLuma 进程已启动、端口可达,再重试。

**Q: 服务起来了但模型不工作**
检查 `.env` 里的 `WATCHING_BOT_API_KEY`,或 `config/default.json` 指向的 `apiKeyEnv` 是否与实际环境变量一致。安装脚本在 key 为空时会提示。

**Q: 面板 401**
设置了 `WATCHING_BOT_PANEL_TOKEN` 但没带 token。URL 加 `?token=xxx` 或请求头 `Authorization: Bearer xxx`。

**Q: Windows 计划任务没有启动**
确认任务存在:`.\\Get-ScheduledTask watching-bot`;手动启动一次并查看 `data/service.log`。计划任务是「登录时触发」,不登录不会跑。
