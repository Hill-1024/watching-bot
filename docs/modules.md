# 插件开发

> 插件是**安装即信任**的本地 Node.js / 浏览器代码。权限声明用于审计与约束宿主接口，不是安全沙箱。
> 安装第三方插件等同于在 watching-bot 进程里运行它的代码。

## 目录结构

```text
plugins/<plugin-id>/
├── module.json          # manifest,唯一导航来源
├── server/index.ts      # 服务端入口:export default async function start(ctx)
├── panel/index.js       # 可选:浏览器 ESM 页面,export default Vue 组件
├── assets/              # 可选:静态资源(只能经由 /plugins/<id>/assets/* 访问)
└── config.schema.json   # 可选:插件配置 schema
```

内置 `builtin` 与 `qq` 和第三方插件走完全相同的契约。

## module.json

```json
{
  "schemaVersion": 1,
  "id": "builtin",
  "name": "Builtin",
  "version": "1.0.0",
  "description": "主人配置与每日咖啡配给",
  "entry": "./server/index.ts",
  "panel": {
    "entry": "./panel/index.js",
    "title": "Builtin",
    "icon": "coffee",
    "route": "builtin",
    "order": 10
  },
  "permissions": ["tools", "perception", "storage", "config"]
}
```

规则:

- `id` 必须匹配 `^[a-z][a-z0-9-]*$`,`core/system/api/plugins` 保留;
- 所有路径解析后必须留在插件目录内;
- `entry` / `panel.entry` 文件必须存在;
- `panel.route` 全局唯一,并自动出现在侧栏「模块」分组。

## 服务端入口

```ts
import type { PluginContext, RunningPlugin } from "../../../src/plugins/types.js";

export default async function start(ctx: PluginContext): Promise<RunningPlugin> {
  return {
    // 暴露给 agent 的黑箱工具
    tools: [],
    // 语义标签:状态管理器只认 social 这类标签
    toolTags: { send_message: ["social"] },
    // 系统提示「可用能力」里的一句话
    summary: "……",
    // 面板能看到的健康状态;不要用「init 返回」冒充健康
    status: () => ({ status: "ready" }),
    // 面板动作:GET/POST /api/plugins/<id>/actions/<path>
    handle: (req) => ({ body: { ok: true, path: req.path } }),
    stop: async () => {},
  };
}
```

### PluginContext

| 字段 | 说明 |
|---|---|
| `config` | `config/default.json` 的 `moduleConfig.<id>` |
| `storage` | 私有 KV(`data/plugins/<id>.json`,原子写),跨重启保留 |
| `emitPerception` | 上报 `message` / `mention` / `mention_storm` / `alert` / `stimulant` |
| `simNow()` | 模拟时间;排程不要用 `Date.now()` |
| `logger` | `debug/info/warn/error` |
| `publish()` | 通知面板本插件状态变化(topic 固定为 `plugin:<id>`) |

## 面板入口

```js
import { defineComponent, onLive, pluginAction, Panel, notify } from "/app/panel-sdk.js";

export default defineComponent({
  setup() {
    const state = ref(null);
    onMounted(async () => {
      state.value = await pluginAction("builtin");           // GET actions/
      off = onLive("plugin:builtin", reload);                 // 事件驱动,不轮询
    });
    return { state, grant: () => pluginAction("builtin", "grant", { method: "POST", body: { cups: 1 } }) };
  },
  template: `<Panel title="今日配给">…</Panel>`,
});
```

`/app/panel-sdk.js` 是版本化契约:Vue、`api`/`pluginAction`、`onLive`、面板组件与格式化函数。页面代码只依赖它,不直接 import 主面板内部文件。

## 通用路由

```text
GET  /api/plugins
GET  /api/plugins/:id
POST /api/plugins/:id/start
POST /api/plugins/:id/stop
ALL  /api/plugins/:id/actions/*
GET  /plugins/:id/panel/*      (静态,面板代码本身不含秘密)
GET  /plugins/:id/assets/*
```

主服务只做鉴权、路径校验、插件查找与超时控制,不认识任何插件业务。

## 生命周期

- 启停单飞,失败会完整清理;
- 与核心工具或其它插件重名时拒绝启动;
- 启停后自动触发 `tools_changed`,核心刷新工具集与能力段;
- 一个插件启动失败不影响其它插件与面板;
- 面板加载失败只坏它自己那一页。

## 事件驱动

面板不轮询。服务端只在真的变化时推 SSE topic:

| topic | 触发 |
|---|---|
| `status` | phase、状态数值、timeScale、睡眠字段变化 |
| `state` | 状态变化(合并窗口 4s) |
| `activity` | 新的思考/输出/工具调用 |
| `injections` | 新的体感/环境注入 |
| `usage` | 一次模型调用落库 |
| `memory` | 记忆归并完成 |
| `plugins` | 插件启停/健康/工具变化 |
| `plugin:<id>` | 插件自己 `ctx.publish()` |

只有订阅了某个 topic 的页面才会拉数据,所以 B 插件的事件不会刷新你正在看的 A 页面。

## 联网搜索(builtin)

`plugins/builtin/server/search.ts` → `web_search`:一个工具,两种后端。DeepSeek 官方搜索端点(`POST {baseUrl}/v1/tools/search`,Bearer key)或 SearXNG(`GET {baseUrl}/search?format=json`)。`provider=auto` 时有 DeepSeek key 优先 DeepSeek,否则用 SearXNG。返回标题、链接、摘要;DeepSeek 可带 `needContent` 取正文。错误会翻译成可执行提示(缺 key、SearXNG 没开 JSON、401/429、超时)。

配置在 `moduleConfig.builtin`(面板 Builtin 页可改,保存到 `data/builtin.json`),详见 [configuration.md](configuration.md#builtin主人咖啡搜索与宿主能力)。

## 宿主能力(builtin)

`plugins/builtin/server/host.ts` → `read_file` / `write_file` / `list_files` / `run_shell`。这是 bot 直接跑在宿主机时的基本 agent 能力:

- 路径默认锁在 `hostTools.workdir` 内,越界需要显式 `allowOutsideWorkdir`;
- `.env` 与 `.git` 默认拒绝访问;读文件拒绝二进制;
- `run_shell` 真实执行宿主命令,带超时、输出上限与 Windows 进程树清理;
- 文件读写大小、shell 超时/输出都有配置上限;`enabled` / `shellEnabled` 可整体关闭。

注意:bot 会读取 QQ 里的不可信内容,shell 也就等于把宿主暴露给可能的提示注入。只接入可信会话,或关掉 shell。

## 标准 MCP 客户端(plugins/mcp)

`plugins/mcp/` 是通用 MCP 客户端,**不包含任何具体 server 的逻辑**:

- `client.ts` 实现两种标准传输:stdio(按行 JSON-RPC,spawn 本地 server)与 SSE(GET 事件流 + POST 消息);支持 `initialize` / `tools/list`(含分页)/ `tools/call`,并应答 server 的 `ping` / `roots/list`。
- `server/index.ts` 读取 `data/mcp.json`(优先,gitignored)或 `moduleConfig.mcp` 的 server 列表,连接后把每个 MCP tool 映射成 `AgentTool`:名字加前缀(默认 `<id>_`),`inputSchema` 原样作为参数 schema,结果里的 text/image 直接转成 pi 的 content。
- **每次工具调用前都会 `ensure` 连接**:已经连着就直接执行;断了就重连、重新 `initialize` + `tools/list`,再执行这一次调用。stdio server 会因此重新拉起进程;SSE 则重连 server。
- 启动时连接失败不会拖垮 bot:插件状态报 `degraded` / `failed`,该 server 的工具为空;修好 server 后重启 `mcp` 插件即可重新发现(运行中掉线则走上面的惰性重连)。
- OBU(`obu mcp`)与 OCU(`ocu mcp`)都是标准 MCP server(stdio)。bot 跑在本机,stdio 直连即可,不需要网关进程。**代码里没有 OBU / OCU 专用桥。**

```json
// data/mcp.json
{"servers":[
  {"id":"obu","transport":"stdio","command":"obu","args":["mcp"],"shell":true,"toolPrefix":"obu_"},
  {"id":"ocu","transport":"stdio","command":"ocu","args":["mcp"],"shell":true,"toolPrefix":"ocu_"}
]}
```

如果某个 server 只提供 SSE(例如跑在另一台机器),把该条改成 `transport: "sse"` + `url` / `headers`,不需要自建桥。

## 本机组件运行时(plugins/runtime)

`plugins/runtime/` 负责「开机只启动主框架,由框架唤醒所有组件」:

- 读 `data/runtime.json`(优先)或 `moduleConfig.runtime.components`;
- 每个组件支持 `command` / `args` / `cwd` / `env`,以及 `check.process` 或 `check.port` 存活探测;
- 已经在跑的外部进程直接接管,不重复拉起;进程退出后按 `ensureIntervalMs` 重新唤醒;
- `delayMs` 控制启动顺序(QQ 先起,SnowLuma 后起);
- 默认 `stopOnExit: false`,框架停止/重启不会杀掉 QQ / SnowLuma,登录态与数据保留;
- 状态与手动唤醒:`GET/POST /api/plugins/runtime/actions/`。

这样系统层只有一个 `watching-bot` 自启入口,新增组件只需改 `data/runtime.json`,不需要再加计划任务/systemd unit。

## QQ 插件作为示例

`plugins/qq/` 是「一个插件 + 两个 runtime」的参考实现:

- `server/onebot/` 是唯一一份 OneBot 11 客户端、工具与消息库;
- `server/runtimes.ts` 只描述 OneBot 地址、WebUI 端口、noVNC、登录入口与安全提示;
- 两套 runtime 都是本机独立进程,由 `runtime` 插件唤醒/保活,bot 只负责连接;
- 切换 runtime = 断开旧连接 + 连新端点,失败回滚;同一时间只允许一套在线。

## 测试

- manifest/路径/工具冲突:参见 `tests/plugins.test.ts`;
- 插件动作与持久化:参见 `tests/builtin-plugin.test.ts`;
- 搜索两种后端:参见 `tests/builtin-search.test.ts`;
- 宿主能力(读写/越界/shell):参见 `tests/builtin-host-tools.test.ts`;
- MCP stdio 工具映射:参见 `tests/mcp-plugin.test.ts`;
- 本机组件唤醒/停止:参见 `tests/runtime-plugin.test.ts`;
- QQ 发图/传文件:参见 `tests/qq-send-media.test.ts`。
