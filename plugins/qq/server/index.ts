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
 * 用户选择 runtime 后,插件:
 *   1. 通过受限 supervisor 安装/启动对应容器(有 supervisor 时);
 *   2. 用同一套适配器连接该 runtime 的 OneBot 端点;
 *   3. 原子持久化选择,重启后保持。
 *
 * 切换失败必须回滚到旧 runtime,并且如实报告「当前没有可用 runtime」,
 * 不能继续把旧选择显示成健康。
 */

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
  let switchSteps: string[] = [];
  const FULL_STEPS = ["安装目标", "断开旧连接", "停止旧进程", "启动新进程", "连接 OneBot"] as const;
  const LOCAL_STEPS = ["断开旧连接", "连接 OneBot"] as const;

  const persistSelection = (id: RuntimeId): void => {
    ctx.storage.set("runtime.selected", id);
  };

  const summaryOf = (): string =>
    `QQ(${RUNTIMES[selected].displayName}):list_chats 看会话与未读、read_messages 读消息、send_message 回消息(可引用回复)、` +
    `mark_read 已读、list_friends/list_groups 通讯录、get_recent_at_mentions 谁在@你、get_profile 自己的资料;` +
    `当群管理:set_group_ban 禁言、set_group_special_title 发定制头衔、get_group_member_info 查身份;贴表情 set_msg_emoji_like;` +
    `表情包:list_memes/view_meme(多模态看图)/save_meme_from_message 收藏消息里的图/rename_meme 命名/send_meme 发表情包`;

  let running: RunningPlugin;

  const refreshSummary = (): void => {
    // summary 是 getter,读的时候就是当前 runtime;这里只负责通知总览重取
    ctx.publishCatalog?.();
  };

  const connect = async (id: RuntimeId): Promise<void> => {
    await adapter.connect(
      {
        url: oneBotUrl(id, cfg),
        token: oneBotToken(id, cfg),
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

  const supervisorAvailable = () => Boolean(ctx.supervisor && cfg.supervisorUrl);

  const supervisorStatus = async (): Promise<Record<string, unknown> | null> => {
    if (!ctx.supervisor) return null;
    try {
      const list = await ctx.supervisor.list();
      return Object.fromEntries(list.map((r) => [r.id, r]));
    } catch (err) {
      ctx.logger.warn(`读取 supervisor 状态失败: ${String(err)}`);
      return null;
    }
  };

  const describeRuntimes = async () => {
    const live = await supervisorStatus();
    return RUNTIME_IDS.map((id) => {
      const d = RUNTIMES[id];
      const st = live?.[id] as { install?: string; process?: string; hostPorts?: Record<string, number> } | undefined;
      return {
        id,
        displayName: d.displayName,
        selected: id === selected,
        image: d.image,
        webuiPort: st?.hostPorts?.["webui"] ?? cfg.hostPorts?.[id] ?? d.webui.defaultHostPort,
        novncPort: d.extraUIs[0]
          ? (st?.hostPorts?.["novnc"] ?? cfg.hostPorts?.snowluma ?? d.extraUIs[0].defaultHostPort)
          : undefined,
        install: st?.install ?? (live ? "not_installed" : "—"),
        process: st?.process ?? "—",
        securityNotes: d.securityNotes,
      };
    });
  };

  const state = async () => {
    const login = await adapter.loginInfo();
    const runtime = RUNTIMES[selected];
    return {
      selected,
      switching,
      switchStage: switching ? switchStage : "",
      switchSteps: switching ? switchSteps : [],
      switchIndex: switching ? Math.max(0, switchSteps.indexOf(switchStage)) : 0,
      supervisor: supervisorAvailable() ? "connected" : ctx.supervisor ? "not_configured" : "unavailable",
      runtime: {
        id: runtime.id,
        displayName: runtime.displayName,
        image: runtime.image,
        containerName: runtime.containerName,
        securityNotes: runtime.securityNotes,
      },
      connection: {
        onebot: adapter.connected ? "connected" : "disconnected",
        selfId: adapter.selfQq || null,
        login: login ? { userId: login.userId, nickname: login.nickname } : null,
      },
      runtimes: await describeRuntimes(),
      login: loginInfoOf(selected, cfg),
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
    const sup = supervisorAvailable() ? ctx.supervisor : undefined;
    switchSteps = [...(sup ? FULL_STEPS : LOCAL_STEPS)];
    const stage = (label: string): void => {
      switchStage = label;
      const index = Math.max(0, switchSteps.indexOf(label));
      // 进度随事件本身发出,页面按 index/steps 换算,不自己编时间
      ctx.publish?.({
        switching: true,
        switchStage: label,
        switchSteps,
        switchIndex: index,
        switchTotal: switchSteps.length,
      });
    };
    try {
      if (sup) {
        // 先确保目标已安装,但不在旧 runtime 仍在线时启动它 —— 同一 QQ 不能双在线
        stage("安装目标");
        await sup.install(target);
      }
      stage("断开旧连接");
      await disconnect();
      if (sup) {
        stage("停止旧进程");
        await sup.stop(previous);
      }
      if (sup) {
        stage("启动新进程");
        await sup.start(target);
      }
      stage("连接 OneBot");
      await connect(target);
      selected = target;
      persistSelection(target);
      refreshSummary();
      ctx.publishCatalog?.();
      lastError = null;
      ctx.logger.info(`QQ runtime 已切换: ${previous} → ${target}`);
      return { body: { ok: true, state: await state() } };
    } catch (err) {
      const reason = `切换到 ${target} 失败: ${String(err)}`;
      ctx.logger.error(reason);
      lastError = reason;
      // 回滚:停目标、起旧 runtime、重连旧 endpoint
      try {
        await disconnect();
        if (sup) {
          await sup.stop(target).catch(() => {});
          await sup.start(previous);
        }
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
      switchSteps = [];
      ctx.publish?.({ switching: false });
    }
  };

  const restart = async (): Promise<PluginResponse> => {
    const sup = supervisorAvailable() ? ctx.supervisor : undefined;
    try {
      if (sup) await sup.restart(selected);
      await reconnect();
      return { body: { ok: true, state: await state() } };
    } catch (err) {
      lastError = `重启失败: ${String(err)}`;
      return { status: 502, body: { ok: false, error: lastError, state: await state() } };
    }
  };

  function status(): PluginHealth {
    const name = RUNTIMES[selected].displayName;
    if (lastError) return { status: "failed", detail: `${name} · ${lastError}` };
    return adapter.connected
      ? { status: "ready", detail: `当前实现 ${name} · OneBot 已连接` }
      : { status: "degraded", detail: `当前实现 ${name} · OneBot 未连接` };
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
        case "POST restart":
          return restart();
        case "POST ports": {
          if (!ctx.supervisor) {
            return { status: 409, body: { error: "未配置 supervisor,无法管理容器端口" } };
          }
          const body = (req.body ?? {}) as { webui?: unknown; novnc?: unknown };
          const hostPorts: { webui?: number; novnc?: number } = {};
          for (const key of ["webui", "novnc"] as const) {
            const v = body[key];
            if (v === undefined) continue;
            if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
              return { status: 400, body: { error: `${key} 必须是 1-65535 的整数` } };
            }
            hostPorts[key] = v;
          }
          if (Object.keys(hostPorts).length === 0) {
            return { status: 400, body: { error: "没有要更新的端口" } };
          }
          try {
            await ctx.supervisor.recreate(selected, { hostPorts });
            cfg.hostPorts = { ...(cfg.hostPorts ?? {}), [selected]: hostPorts.webui ?? cfg.hostPorts?.[selected] };
            await reconnect();
            return { body: { ok: true, state: await state() } };
          } catch (err) {
            lastError = `修改端口失败: ${String(err)}`;
            return { status: 502, body: { ok: false, error: lastError, state: await state() } };
          }
        }
        case "GET logs": {
          if (!ctx.supervisor) {
            return { status: 409, body: { error: "未配置 supervisor,无法读取容器日志" } };
          }
          const tail = Number(req.query.tail ?? 200);
          const text = await ctx.supervisor.logs(selected, Number.isFinite(tail) ? tail : 200);
          return { body: { runtime: selected, logs: text.slice(-20_000) } };
        }
        default:
          return { status: 404, body: { error: `未知动作: ${req.method} ${req.path}` } };
    }
  }

  running = {
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
  return running;
}
