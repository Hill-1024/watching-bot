# 配置详解

主配置 `config/default.json`(可用 `WATCHING_BOT_CONFIG` 换路径)。所有状态变量、阈值、节流参数都是配置,加减维度不改代码。密钥一律走环境变量,不落配置文件。

> **面板热切换**:管理面板的「模型」区可以在不重启的情况下切换 provider/模型(写 `data/model.json` 覆盖层,优先于本文件的 model 段;删掉该文件即回退到文件配置)。API key 也可在面板写入(明文存 `data/model.json`,该目录已 gitignore)。

## 模型接入(复用 pi 网关)

`src/core/llm.ts` 直接用 pi 的模型网关(`builtinModels()`,40+ 内置 provider),不自研。`model.baseUrl` 是否配置决定走哪条路径:

### 路径 A:pi 目录 provider(推荐,不配 baseUrl)

```json
"model": {
  "provider": "zai-coding-cn",      // pi 目录 provider id
  "model": "glm-5.3-flash",         // 目录模型 id
  "apiKeyEnv": "ZAI_API_KEY",
  "contextWindow": 0                // 0 = 用目录自带的窗口配置
}
```

目录里常用的(完整列表见报错信息或 pi 文档):

| provider | 说明 | 端点 | 常用模型 |
|---|---|---|---|
| `zai` | Z.AI 国际 | api.z.ai | glm-4.7, glm-5.3, glm-5.3-flash |
| `zai-coding-cn` | 智谱大陆(coding plan) | open.bigmodel.cn/api/coding | glm-5.3-flash, glm-4.6v |
| `deepseek` | DeepSeek 官方 | api.deepseek.com | deepseek-flash, deepseek-v4-pro |
| `openai` / `anthropic` / `google` / `openrouter` / `moonshotai-cn` / `minimax-cn` … | 40+ 全在目录里 | — | — |

API key 按优先级:`apiKeyEnv` 指定的环境变量 → pi 标准环境变量(`OPENAI_API_KEY`、`DEEPSEEK_API_KEY` 等,由 pi 的 `getEnvApiKey` 解析)。

### 路径 B:任意 OpenAI 兼容端点(配 baseUrl)

```json
"model": {
  "provider": "watching-bot-custom",
  "baseUrl": "https://open.bigmodel.cn/api/paas/v4",   // GLM 开放平台通用端点
  "model": "glm-4.7",
  "apiKeyEnv": "WATCHING_BOT_API_KEY",
  "contextWindow": 128000
}
```

用 pi 的 `createProvider` + 内置 openai-completions 实现注册为自定义 provider,兼容怪癖由 pi 按 baseUrl 自动探测。自建网关、vLLM、LM Studio 都走这条。

### 测试路径:faux(无密钥)

`WATCHING_BOT_FAUX_LLM=1` 启动 → 用 pi 自带的 faux provider 跑一个规则剧本,全链路不需要任何 API key。见 `docs/deployment.md`。

> 模型热切换会同步重建 pi 句柄;agent 的 compaction 窗口读取当前生效的 `model.contextWindow`(含 `data/model.json` 覆盖),不会停留在启动时的旧值。面板显示的 provider/model 与实际 agent 使用的一致。

## time:时间模型

| 字段 | 默认 | 说明 |
|---|---|---|
| `timeScale` | 1 | 模拟时间倍率。1=真实;调试用 300(1 真实秒=5 模拟分)。面板可热调。QQ 消息收发永远走真实时间 |
| `simStart` | — | 模拟时间起点(ISO);有快照时从快照续 |
| `tickRealMs` | 1000 | 系统心跳周期(真实 ms) |

## state:五维状态

`state.vars` 定义每个变量的 `{min, max, init}` —— 加减维度就是加删一段配置。v1 五维:疲惫 fatigue(0-100)、心情 mood(-100..100)、烦躁 annoyance、压力 stress、社交电量 social。

`state.rules` 动力学(模拟时间单位):

| 参数 | 默认 | 含义 |
|---|---|---|
| `fatiguePerSimHourAwake` | 5.5 | 清醒时每小时疲惫增速(100/5.5≈18h 不睡会到 100) |
| `fatiguePerTurn` | 0.4 | 每轮 LLM 对话额外疲惫 |
| `fatigueRecoveryPerSimHour` | 14 | 睡眠每小时恢复(满血约需 6-7 模拟时睡眠) |
| `annoyanceDecayPerSimHour` | 3 | 烦躁清醒衰减(睡眠中 ×3 加速) |
| `annoyancePerAlarmRing` | 9 | 每次闹钟响铃 |
| `annoyancePerStormTick` | 4 | 被@时每次 |
| `moodRegressionToBaselinePerSimHour` / `moodBaseline` | 0.5 / 10 | 心情向基线回归 |
| `stressDecayPerSimHour` / `socialRecoveryPerSimHourAlone` | 1.5 / 2 | 压力衰减/独处回电 |

**调参建议**:改完在 faux 模式跑 24h 模拟(timeScale=600),对照面板状态曲线检查:昼夜节奏是否合理、有没有「永远睡不着/一直睡」的死区。`state_history` 表可以直接 SQL 复盘。

`state.thresholds` 行为阈值:

| 参数 | 默认 | 行为 |
|---|---|---|
| `drowsyInject` / `drowsyTier2` / `drowsyTier3` | 45/65/78 | 困意注入三档(三档文案会催它自己去睡) |
| `forcedSleep` | 90 | 强制入睡 |
| `naturalWake` | 22 | 睡到这么低自然醒 |
| `drowsyOnWake` | 32 | 醒来时高于此值 → 注入「没睡够」 |
| `sleepHardCapSimMinutes` | 720 | 连续睡眠硬上限(12 模拟时) |
| `alarmRingIntervalSimMinutes` | 10 | 赖床后闹钟重响间隔 |
| `stormWindowSimMinutes` / `stormMinMentions` | 3 / 5 | 窗口内被@≥5 次判为风暴 |
| `feelingRepeatCooldownSimMinutes` | 45 | 同类体感注入冷却 |

## loop:循环节奏

| 参数 | 默认 | 说明 |
|---|---|---|
| `heartbeatSimMinutes` | 20 | 没事做时的心跳间隔 |
| `emptyBackoffBaseSimMinutes` / `Max` | 30 / 180 | 空响应退避(30→60→120→180 封顶) |
| `hotTailMessages` | 40 | (预留)热上下文尾部条数 |

## memory / sleep / judge

- `memory`:数据目录、MEMORY.md 路径、日记目录、`consolidateDiaryDaysToWeek`(攒几篇日记做周归并,默认 7)。
- `sleep`:`wakeOnStorm`(睡眠中@风暴是否打断,默认 true)、`maxSnoozeBeforeForcedWake`(赖床上限,默认 3,超过强制拽醒)、`minFatigueToSleep`(入睡尝试门槛,默认 28;低于它躺下只是 resting 放空,不算睡着)。
- `judge`:`enabled`、`cooldownSimMinutes`(30)、`maxCallsPerSimDay`(6)—— 实时通道限流;睡眠通道零额外调用不受此限。

## modules / moduleConfig

`modules` 数组控制启用哪些模块,`moduleConfig.<name>` 是各模块独立配置段。napcat 段:`url`(WS 地址,可被环境变量 `NAPCAT_URL` 覆盖,compose 里是 `ws://napcat:3001`)、`token`、`selfId`(0=自取)、`dbPath`、`memeDir`、`sendMinIntervalMs`/`sendJitterMs`(发送节流)。

### QQ 接入:NapCat / SnowLuma 二选一

`napcat` 与 `snowluma` 是互斥的 QQ 接入运行时,不会同时启动;选择保存在 `data/qq-backend.json`(gitignored),缺失或损坏时默认 **NapCat**。面板「模块与系统 → QQ 接入」可热切换并持久化,`modules` 数组里的这两个名字会被选择结果替代,其他模块仍由数组控制。

两套运行时都走 OneBot 11,SnowLuma 模块复用 NapCat 的同一套 21 个工具,并默认共用 `data/modules/napcat.db` 与 `data/modules/memes`(切换后消息、未读、表情包延续)。`moduleConfig.snowluma` 与 napcat 同构,默认 WS 也是 `ws://127.0.0.1:3001`;若两个运行时同时开着,需要给 SnowLuma 配一个不同的 `url` 并在它自己的 WebUI 里监听对应端口。切换只停/启 agent 侧模块,不负责启动或停止 QQ 进程。

NapCat 卡片还会读取本地 WebUI 配置(默认 `runtime/napcat-node/napcat/config/webui.json`),展示登录 token;保存新端口会原子写回该文件,面板随后轮询新端口并等待 NapCat 重启。Docker 等路径可用 `NAPCAT_WEBUI_CONFIG` 指定配置文件,或用 `NAPCAT_WEBUI_TOKEN` 直接给 token。

### builtin:主人与咖啡

`moduleConfig.builtin`:

- `master.name` / `master.qq`:主人称呼与 QQ;QQ 用于睡眠私聊唤醒的主人豁免,以及喝完咖啡后上 QQ 讨要的目标。
- `coffee.dailyQuota` / `coffee.refillSimHour`:每日默认配额与模拟时间送达小时。

面板可编辑称呼、QQ、每日配额;保存时原子写入 `data/builtin.json`(gitignored),并热应用。配额修改从下一次每日配给生效,今日余量可用面板补货按钮调整。

## panel

`enabled` / `port`(8080)/ `tokenEnv`(`WATCHING_BOT_PANEL_TOKEN`,未设 = 无鉴权,仅限本机调试用)。

## 环境变量总表

| 变量 | 用途 |
|---|---|
| `WATCHING_BOT_API_KEY` | 默认配置的模型 key(路径 B) |
| `DEEPSEEK_API_KEY` / `ZAI_API_KEY` / `OPENAI_API_KEY` … | 路径 A 各 provider 的 key(pi 标准名) |
| `WATCHING_BOT_FAUX_LLM=1` | faux 剧本 LLM(测试) |
| `WATCHING_BOT_TIMESCALE` | 覆盖 timeScale |
| `WATCHING_BOT_CONFIG` | 配置文件路径 |
| `WATCHING_BOT_STATE_FILE` | 快照文件路径(默认 `data/state.json`;隔离测试实例用) |
| `WATCHING_BOT_PANEL_TOKEN` | 面板 token |
| `NAPCAT_URL` / `NAPCAT_TOKEN` | 覆盖 napcat 模块连接参数 |
| `SNOWLUMA_URL` / `SNOWLUMA_TOKEN` | 覆盖 snowluma 模块连接参数 |
| `NAPCAT_WEBUI_CONFIG` / `NAPCAT_WEBUI_TOKEN` | 覆盖面板读取的 NapCat WebUI 配置路径/token |
| `QQ_ACCOUNT` | compose 里 NapCat 的 QQ 号 |
