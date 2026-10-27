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
- `panel.route` 全局唯一,并自动出现在侧栏「模块」分组;
- `runtimeAccess` 只能写 `napcat` / `snowluma`,不能传镜像、命令或宿主路径。

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
| `supervisor` | 仅在 manifest 声明 `runtimeAccess` 时注入,只能按 runtime ID 操作 |
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

## QQ 插件作为示例

`plugins/qq/` 是「一个插件 + 两个 runtime」的参考实现:

- `server/onebot/` 是唯一一份 OneBot 11 客户端、工具与消息库;
- `server/runtimes.ts` 只描述 WebUI 端口、noVNC、登录入口与安全提示;
- 切换 runtime 会停旧容器、起新容器、重连 OneBot,失败回滚;
- 同一时间只允许一套 runtime 在线。

## 测试

- manifest/路径/工具冲突:参见 `tests/plugins.test.ts`;
- 插件动作与持久化:参见 `tests/builtin-plugin.test.ts`;
- runtime 白名单与 supervisor:参见 `tests/supervisor.test.ts`。
