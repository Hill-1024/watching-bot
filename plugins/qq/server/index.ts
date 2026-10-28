import type { PluginContext, PluginHealth, PluginResponse, RunningPlugin } from "../../../src/plugins/types.js";
import { OneBotAdapter } from "./onebot/adapter.js";
import {
  RUNTIMES,
  RUNTIME_IDS,
  isRuntimeId,
  loginInfoOf,
  oneBotToken,
  oneBotUrl,
  type QqRuntimeConfig,
  type RuntimeId,
} from "./runtimes.js";

/**
 * QQ 插件:整个项目唯一了解 QQ 的地方。
 *
 * 只有一个插件身份、一份 OneBot v11 实现;NapCat / SnowLuma 是 1-of-2 runtime。
 * 两套 runtime 都由用户(或系统服务)作为独立进程跑在本机,bot 只负责连接它们的
 * OneBot WebSocket,不安装、不拉起、不停止 QQ 进程。
 *
 * 切换 runtime = 断开旧连接 + 连新端点;失败回滚到旧 runtime,并如实报告连接状态。
 */

const SWITCH_STEPS = ["断开旧连接", "连接 OneBot"] as const;

export default async function start(ctx: PluginContext): Promise<RunningPlugin> {
  const cfg = (ctx.config ?? {}) as QqRuntimeConfig;
  const adapter = new OneBotAdapter();
  const host = {
    emitPerception: ctx.emitPerception,
    log: (msg: string) => ctx.logger.info(msg),
    onConnectionChange: () => ctx.publish?.(),
  };

  const stored = ctx.storage.get<unknown>("runtime.selected", null);
  let selected: RuntimeId = isRuntimeId(stored) ? stored : isRuntimeId(cfg.runtime) ? cfg.runtime : "napcat";
  let lastError: string | null = null;
  let switching = false;
  let switchStage = "";

  const persistSelection = (id: RuntimeId): void => {
    ctx.storage.set("runtime.selected", id);
  };

  const summaryOf = (): string =>
    `QQ(${RUNTIMES[selected].displayName}):list_chats 看会话与未读、read_messages 读消息、send_message 回消息(可引用回复、带图、传文件)、` +
    `mark_read 已读、list_friends/list_groups 通讯录、get_recent_at_mentions 谁在@你、get_profile 自己的资料;` +
    `当群管理:set_group_ban 禁言、set_group_special_title 发定制头衔、get_group_member_info 查身份;贴表情 set_msg_emoji_like;` +
    `表情包:list_memes/view_meme(多模态看图)/save_meme_from_message 收藏消息里的图/rename_meme 命名/send_meme 发表情包`;

  const storedToken = (id: RuntimeId): string => {
    const v = ctx.storage.get<unknown>(`runtime.token.${id}`, "");
    return typeof v === "string" ? v.trim() : "";
  };

  /** 生效 token:面板手填 > 配置文件 */
  const effectiveToken = (id: RuntimeId): string => storedToken(id) || oneBotToken(id, cfg);

  const connect = async (id: RuntimeId): Promise<void> => {
    await adapter.connect(
      {
        url: oneBotUrl(id, cfg),
        token: effectiveToken(id),
        selfId: cfg.selfId,
        dbPath: cfg.dbPath ?? "data/modules/napcat.db",
        memeDir: cfg.memeDir ?? "data/modules/memes",
        sendMinIntervalMs: cfg.sendMinIntervalMs,
        sendJitterMs: cfg.sendJitterMs,
      },
      host,
    );
    ctx.logger.info(`OneBot 端点(${RUNTIMES[id].displayName}): ${oneBotUrl(id, cfg)}`);
  };

  const disconnect = async (): Promise<void> => {
    await adapter.stop();
  };

  await connect(selected);
  persistSelection(selected);

  const describeRuntimes = () =>
    RUNTIME_IDS.map((id) => {
      const d = RUNTIMES[id];
      return {
        id,
        displayName: d.displayName,
        selected: id === selected,
        onebotUrl: oneBotUrl(id, cfg),
        webuiPort: cfg.hostPorts?.[id] ?? d.webui.defaultPort,
        novncPort: d.remoteDesktop?.defaultPort,
        securityNotes: d.securityNotes,
      };
    });

  const state = async () => {
    const login = await adapter.loginInfo();
    return {
      selected,
      switching,
      switchStage: switching ? switchStage : "",
      switchSteps: switching ? [...SWITCH_STEPS] : [],
      switchIndex: switching ? Math.max(0, SWITCH_STEPS.indexOf(switchStage as never)) : 0,
      connection: {
        onebot: adapter.connected ? "connected" : "disconnected",
        selfId: adapter.selfQq || null,
        login: login ? { userId: login.userId, nickname: login.nickname } : null,
      },
      runtimes: describeRuntimes(),
      login: loginInfoOf(selected, cfg),
      onebotToken: {
        override: storedToken(selected),
        effective: effectiveToken(selected),
      },
      lastError,
    };
  };

  const reconnect = async (): Promise<void> => {
    await disconnect();
    await connect(selected);
    lastError = null;
  };

  const switchRuntime = async (target: RuntimeId): Promise<PluginResponse> => {
    if (target === selected && adapter.connected) {
      return { body: { ok: true, state: await state() } };
    }
    switching = true;
    const previous = selected;
    const stage = (label: string): void => {
      switchStage = label;
      ctx.publish?.({
        switching: true,
        switchStage: label,
        switchSteps: [...SWITCH_STEPS],
        switchIndex: Math.max(0, SWITCH_STEPS.indexOf(label as never)),
        switchTotal: SWITCH_STEPS.length,
      });
    };
    try {
      stage("断开旧连接");
      await disconnect();
      stage("连接 OneBot");
      await connect(target);
      selected = target;
      persistSelection(target);
      ctx.publishCatalog?.();
      lastError = null;
      ctx.logger.info(`QQ runtime 已切换: ${previous} → ${target}`);
      return { body: { ok: true, state: await state() } };
    } catch (err) {
      const reason = `切换到 ${target} 失败: ${String(err)}`;
      ctx.logger.error(reason);
      lastError = reason;
      try {
        await disconnect();
        await connect(previous);
        selected = previous;
        persistSelection(previous);
        lastError = `${reason};已回滚到 ${previous}`;
      } catch (rollbackErr) {
        lastError = `${reason};回滚也失败: ${String(rollbackErr)}。当前没有可用的 QQ runtime。`;
        ctx.logger.error(lastError);
      }
      return { status: 502, body: { ok: false, error: lastError, state: await state() } };
    } finally {
      switching = false;
      switchStage = "";
      ctx.publish?.({ switching: false });
    }
  };

  function status(): PluginHealth {
    const name = RUNTIMES[selected].displayName;
    if (lastError) return { status: "failed", detail: `${name} · ${lastError}` };
    return adapter.connected
      ? { status: "ready", detail: `当前实现 ${name} · OneBot 已连接` }
      : { status: "degraded", detail: `当前实现 ${name} · OneBot 未连接(QQ 进程启动了吗?)` };
  }

  async function handle(req: Parameters<NonNullable<RunningPlugin["handle"]>>[0]): Promise<PluginResponse> {
    switch (`${req.method} ${req.path}`) {
      case "GET ":
        return { body: await state() };
      case "POST select": {
        const target = (req.body as { runtime?: unknown } | null)?.runtime;
        if (!isRuntimeId(target)) {
          return { status: 400, body: { error: "runtime 必须是 napcat 或 snowluma" } };
        }
        return switchRuntime(target);
      }
      case "POST reconnect":
        try {
          await reconnect();
          return { body: { ok: true, state: await state() } };
        } catch (err) {
          lastError = `重连失败: ${String(err)}`;
          return { status: 502, body: { ok: false, error: lastError, state: await state() } };
        }
      case "POST token": {
        const raw = (req.body as { token?: unknown } | null)?.token;
        if (raw !== undefined && typeof raw !== "string") {
          return { status: 400, body: { error: "token 必须是字符串" } };
        }
        const token = typeof raw === "string" ? raw.trim() : "";
        if (token.length > 512 || /[\r\n]/.test(token)) {
          return { status: 400, body: { error: "token 过长或含换行" } };
        }
        if (token) ctx.storage.set(`runtime.token.${selected}`, token);
        else ctx.storage.delete(`runtime.token.${selected}`);
        try {
          await reconnect();
          return { body: { ok: true, state: await state() } };
        } catch (err) {
          lastError = `应用 token 后重连失败: ${String(err)}`;
          return { status: 502, body: { ok: false, error: lastError, state: await state() } };
        }
      }
      // 兼容旧面板:本地模式没有可重启的进程,restart 等价于重连
      case "POST restart":
        try {
          await reconnect();
          return { body: { ok: true, state: await state() } };
        } catch (err) {
          lastError = `重连失败: ${String(err)}`;
          return { status: 502, body: { ok: false, error: lastError, state: await state() } };
        }
      default:
        return { status: 404, body: { error: `未知动作: ${req.method} ${req.path}` } };
    }
  }

  return {
    tools: adapter.tools,
    toolTags: adapter.toolTags,
    get summary() {
      return summaryOf();
    },
    status,
    handle,
    stop: async () => {
      persistSelection(selected);
      await disconnect();
    },
  };
}
