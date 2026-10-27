# 部署指南

三种方式,按需选择。前置依赖:Node ≥ 22.19(本机跑需要)、Docker(compose 跑需要)、一个 GitHub 可达的网络。

## 方式一:本地无 QQ 体验(5 分钟,零密钥)

不需要真 QQ 号、不需要模型 key,用 pi 的 faux provider(规则剧本 LLM)+ 假 OneBot 服务器走通全部机制:

```bash
npm install

# 终端 1:假 QQ(OneBot 11 服务器,3001 端口;内置测试图片服务 3002)
npm run mock:onebot            # 加 --storm 启动即来一轮@风暴

# 终端 2:watching-bot(faux LLM + 300 倍时间)
WATCHING_BOT_FAUX_LLM=1 WATCHING_BOT_TIMESCALE=300 npm start
```

打开面板 `http://127.0.0.1:8080`(未设 token 则免鉴权),你会看到:

- 模拟时间飞驰,状态五维曲线起伏;
- Vue 3 面板的八个页面:概览、状态与历史、活动日志、感知注入、Token 统计、长期记忆、模型、模块与系统;活动日志与记忆摘要会自动增量刷新,状态输入在轮询期间不会被覆盖;
- faux 剧本驱动的完整行为链:感知消息 → list_chats → read_messages → 收藏表情包 → 发表情包 → 引用回复 → mark_read;疲惫三档注入 → 自愿睡/强制睡 → 睡眠期归并(写日记+更新 MEMORY.md)→ 闹钟响铃赖床 → 疲惫恢复自然醒;
- `data/memories/` 里出现日记,`data/MEMORY.md` 索引被归并更新。

调试某一环时把 `WATCHING_BOT_TIMESCALE` 调大(600)快速推进,定位时调小(1)慢慢看。

## 方式二:本机直连 NapCat(shell 版)

适合开发期联调真实 QQ:

1. **起 NapCat**:从 [NapNeko/NapCatQQ Releases](https://github.com/NapNeko/NapCatQQ/releases) 下载 `NapCat.Shell.zip`,运行 `launcher.bat` 扫码登录。
2. **配正向 WS**:NapCat WebUI(默认 `http://127.0.0.1:6099`)→ 网络配置 → 新建 → **WebSocket 服务器**,端口 `3001`,token 可选。
3. **配置并启动 bot**:`config/default.json` 的 napcat 段保持 `ws://127.0.0.1:3001`;模型按 `docs/configuration.md` 接入;然后:

```bash
WATCHING_BOT_API_KEY=你的key WATCHING_BOT_PANEL_TOKEN=面板密码 npm start
```

> `third_party/napcat` 子模块只是源码参考,这种方式下并不运行它;真要读它的协议实现再 `git submodule update --init`。

## 方式三:Docker Compose(推荐长期挂机)

预构建镜像(linux/amd64 + linux/arm64,由 GitHub Actions 构建并冒烟验证):

```bash
docker pull ghcr.io/hill-1024/watching-bot:latest
# 或锁定版本:ghcr.io/hill-1024/watching-bot:0.1.1
```

正式镜像**只由 `v*` 版本 tag 构建**,`latest` 跟随最新 release;main 分支推送不会发布镜像。当前版本 v0.1.1。

仓库自带的 `docker-compose.yml` 已指向该镜像,`docker compose up -d` 直接拉取;想从源码构建则用 `docker compose up -d --build`。

```bash
# 准备 .env(同目录)
cat > .env <<'EOF'
WATCHING_BOT_API_KEY=你的模型key
WATCHING_BOT_PANEL_TOKEN=面板密码
QQ_ACCOUNT=你的QQ号
# NAPCAT_TOKEN=给OneBot WS加个token(可选,需与NapCat WebUI里配置一致)
# WATCHING_BOT_TIMESCALE=1
EOF

docker compose up -d
docker compose logs -f watching-bot   # 看日志
```

步骤:

1. **NapCat 登录**:浏览器开 `http://127.0.0.1:6099` → 扫码登录 QQ。NapCat 数据在 `napcat-data` 卷里,重启容器不用重新扫码。
2. **配 OneBot WS**:NapCat WebUI → 网络配置 → 新建 → **WebSocket 服务器**,端口填 `3001`(容器内),勾选启用。watching-bot 侧已通过 `NAPCAT_URL=ws://napcat:3001` 指向它,无需改配置。
3. **模型**:compose 挂载了 `./config`,直接编辑 `config/default.json` 后 `docker compose restart watching-bot` 生效。
4. **面板**:`http://127.0.0.1:8080/?token=<WATCHING_BOT_PANEL_TOKEN>`。NapCat 卡片会显示 WebUI 登录 token,也可在面板里保存自定义 WebUI 端口;端口修改后需要重启 NapCat 运行时,面板会等待新端口就绪。

### SnowLuma(可选,非默认)

SnowLuma 与 NapCat 互斥,默认仍使用 NapCat。SnowLuma 不在当前 compose 的默认服务里,需要自行运行它的 OneBot WS:

1. 启动 SnowLuma(官方发行包或你自己的容器),在它的 WebUI 里配置 OneBot **WebSocket 服务器**;
2. 给 bot 一个可达地址:容器部署用 `SNOWLUMA_URL=ws://<snowluma-host>:3001`,本机默认 `ws://127.0.0.1:3001`;
3. 如需独立 token,配置 `moduleConfig.snowluma.token` 或 `SNOWLUMA_TOKEN`;
4. 打开面板「模块与系统 → QQ 接入」选择 SnowLuma。选择写入 `data/qq-backend.json`,重启后保持。

两套运行时共用 `data/modules/napcat.db` 与 `data/modules/memes`;同一个 QQ 号不能同时让 NapCat 和 SnowLuma 在线,切换前停掉另一个运行时。面板只切换 agent 侧模块,不负责启动/停止 SnowLuma 进程。

### 数据与备份

| 数据 | 位置 | 说明 |
|---|---|---|
| bot 状态/记忆/表情包 | `./data`(宿主机目录) | SQLite + state.json + MEMORY.md + memories/ + modules/;备份 = 拷走这个目录 |
| NapCat 登录态 | `napcat-data` 卷 | `docker volume` 管理 |

### 升级

使用发布镜像时:

```bash
docker compose pull watching-bot
docker compose up -d
```

版本镜像只由版本 tag 构建;想固定版本,把 compose 的 `image` 改成 `:0.1.1`。从源码构建时:

```bash
git pull
git submodule update --init        # 跟进 napcat 指针(可选)
docker compose build watching-bot
docker compose up -d
```

## 访问宿主机上的服务(本地模型网关等)

主框架跑在容器里,**容器内的 `127.0.0.1` / `localhost` 是容器自己**,不是你的电脑。你在宿主机上跑的本地网关(pi gateway、Ollama、LM Studio、各类 OpenAI 兼容端点)必须用下面这个别名访问:

```text
http://host.docker.internal:<端口>/v1
```

- compose 已给 `watching-bot` 注入 `extra_hosts: host.docker.internal:host-gateway`,Docker Desktop 与 Linux 都开箱可用,不需要改代码或重建镜像;
- 面板「模型 → baseUrl」填 `http://127.0.0.1:3425/v1` 这类回环地址会被**拒绝并提示正确写法**(不会静默改写,避免你以为填对了);面板提供「一键替换」按钮;
- 启动时如果 `data/model.json` 里存的仍是回环地址,日志会打 `[model][warn]` 并在模型页显示红色提示;
- 宿主机直跑(非 Docker)时 `127.0.0.1` 仍然正常,不受影响。

## 模拟时间与真实时间

`time.syncOnResume`(默认 `true`)在 `timeScale=1` 时把重启后的模拟钟对齐真实时间:机器关机/容器停止期间模拟时间不会前进,不校正的话「它的一天」会永久落后(例如停机 24 小时,它就一直在过昨天)。允许的偏差由 `time.maxResumeDriftSimMinutes`(默认 10 分钟)控制,校正时会打一行日志说明偏差多少小时。`timeScale > 1` 的加速测试模式不做校正(模拟时间本来就会跑在真实时间前面)。

## 环境变量

见 `docs/configuration.md` 末尾的总表。

## 常见问题

**Q: 日志里反复「连接断开,Ns 后重连」**
NapCat 侧 WS 服务器没建好、端口不对或 token 不匹配。compose 场景确认 NapCat WebUI 里建的是「WebSocket **服务器**」且容器端口是 3001;bot 重连是自动的,修好配置即可。

**Q: 面板切到 SnowLuma 后没有反应**
面板只切换 agent 侧模块;SnowLuma 的 OneBot WS 需要已经在 `SNOWLUMA_URL` / `moduleConfig.snowluma.url` 上监听。确认 SnowLuma 进程已启动、端口可达,再切回 NapCat 或重试。

**Q: 面板 401**
设置了 `WATCHING_BOT_PANEL_TOKEN` 但没带 token。URL 加 `?token=xxx` 或请求头 `Authorization: Bearer xxx`。

**Q: 机器人深夜没睡/一直睡**
调 `state.rules` 的疲惫动力学与 `state.thresholds` 阈值,配合 faux 模式 + timeScale 加速复盘(见 configuration.md 调参建议)。注意 timeScale 越大,模拟时间过得越快,疲惫涨得也越快 —— 面板上的「一天」是模拟时间。

**Q: 发消息被 QQ 风控/发送很慢**
napcat 模块内置发送节流(`sendMinIntervalMs` + 随机抖动),这是特性。仍被风控就调大间隔,或减少发言频率(它本来就有不回消息的自由)。

**Q: 重启后它会记得之前的事吗**
会。`data/state.json` 恢复变量与对话上下文,长期记忆在 MEMORY.md/日记里,消息历史在模块库里;模型覆盖在 `data/model.json`,QQ 后端选择在 `data/qq-backend.json`。唯一简化:重启后一律以清醒态恢复(睡到一半被杀进程的,醒来继续)。

**Q: 时区**
模拟时间的「一天」跟宿主机时区走;compose 里默认 `TZ=Asia/Shanghai`。

## 方式三补充:runtime supervisor

从本版本起,compose 不再直接托管 NapCat。`docker-compose.yml` 只有两个服务:

- `runtime-supervisor`:唯一挂载 `/var/run/docker.sock` 的容器,只监听内网 `:8099`;
- `watching-bot`:面板 + agent,通过 `WATCHING_BOT_SUPERVISOR_URL/TOKEN` 调 supervisor。

QQ 容器由 supervisor 按需创建,容器名固定为 `watching-qq-napcat` / `watching-qq-snowluma`,接入网络 `watching-bot-qqnet`,别名 `napcat` / `snowluma`。OneBot 的 3001 端口不发布到宿主,主进程用 `ws://napcat:3001` 或 `ws://snowluma:3001` 连接。

```bash
cp .env.example .env
# 至少填:WATCHING_BOT_API_KEY、WATCHING_BOT_PANEL_TOKEN、WATCHING_BOT_SUPERVISOR_TOKEN
docker compose up -d
```

首次使用:

1. 打开面板 → 模块 → QQ;
2. 选择 NapCat 或 SnowLuma → 自动拉镜像、建卷、建容器、启动;
3. 点 WebUI(或 SnowLuma 的 noVNC)扫码登录;
4. 在 WebUI 里确认 OneBot v11 WS 监听 3001;
5. 回到 QQ 页面点「重连 OneBot」。

宿主端口默认只绑 `127.0.0.1`:

```text
NapCat WebUI     127.0.0.1:6099
SnowLuma WebUI   127.0.0.1:5099
SnowLuma noVNC   127.0.0.1:6081
OneBot WS        不发布
```

改端口会在 QQ 页面重建容器;数据卷不动,所以登录态与消息不会丢。

切换 runtime 的语义:先停旧 runtime,再启新 runtime,连接成功后才把选择写盘。失败会回滚到旧 runtime;如果回滚也失败,页面会明确显示「当前没有可用 runtime」,不会假装健康。

安全提醒:

- SnowLuma 官方要求 `SYS_PTRACE` 与 `seccomp=unconfined`,安装前请确认能接受;
- supervisor 等价于 Docker 高权限,`WATCHING_BOT_SUPERVISOR_TOKEN` 必须是长随机串;
- 不要把面板、WebUI 或 noVNC 暴露到公网;需要远程访问就套 TLS 反向代理;
- SnowLuma 的初始口令可能只出现在首次容器日志里,从 QQ 页面的「容器日志」读取。
