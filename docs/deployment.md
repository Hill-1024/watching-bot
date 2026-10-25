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
# 或锁定版本:ghcr.io/hill-1024/watching-bot:0.1.0
```

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
4. **面板**:`http://127.0.0.1:8080/?token=<WATCHING_BOT_PANEL_TOKEN>`。

### 数据与备份

| 数据 | 位置 | 说明 |
|---|---|---|
| bot 状态/记忆/表情包 | `./data`(宿主机目录) | SQLite + state.json + MEMORY.md + memories/ + modules/;备份 = 拷走这个目录 |
| NapCat 登录态 | `napcat-data` 卷 | `docker volume` 管理 |

### 升级

```bash
git pull
git submodule update --init        # 跟进 napcat 指针(可选)
docker compose build watching-bot
docker compose up -d
```

## 环境变量

见 `docs/configuration.md` 末尾的总表。

## 常见问题

**Q: 日志里反复「连接断开,Ns 后重连」**
NapCat 侧 WS 服务器没建好、端口不对或 token 不匹配。compose 场景确认 NapCat WebUI 里建的是「WebSocket **服务器**」且容器端口是 3001;bot 重连是自动的,修好配置即可。

**Q: 面板 401**
设置了 `WATCHING_BOT_PANEL_TOKEN` 但没带 token。URL 加 `?token=xxx` 或请求头 `Authorization: Bearer xxx`。

**Q: 机器人深夜没睡/一直睡**
调 `state.rules` 的疲惫动力学与 `state.thresholds` 阈值,配合 faux 模式 + timeScale 加速复盘(见 configuration.md 调参建议)。注意 timeScale 越大,模拟时间过得越快,疲惫涨得也越快 —— 面板上的「一天」是模拟时间。

**Q: 发消息被 QQ 风控/发送很慢**
napcat 模块内置发送节流(`sendMinIntervalMs` + 随机抖动),这是特性。仍被风控就调大间隔,或减少发言频率(它本来就有不回消息的自由)。

**Q: 重启后它会记得之前的事吗**
会。`data/state.json` 恢复变量与对话上下文,长期记忆在 MEMORY.md/日记里,消息历史在模块库里。唯一简化:重启后一律以清醒态恢复(睡到一半被杀进程的,醒来继续)。

**Q: 时区**
模拟时间的「一天」跟宿主机时区走;compose 里默认 `TZ=Asia/Shanghai`。
