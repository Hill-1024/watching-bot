import { spawnSync } from "node:child_process";
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
  type SnowlumaInitialCredentials,
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

  const supervisorAvailable = () => Boolean(ctx.supervisor && cfg.supervisorUrl);

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

  /** 从 runtime 自己的配置文件里读 OneBot token(SnowLuma: onebot.json 的 wsServers[].accessToken) */
  const runtimeConfigToken = async (id: RuntimeId): Promise<string> => {
    if (!ctx.supervisor || !supervisorAvailable() || id !== "snowluma") return "";
    try {
      const raw = await ctx.supervisor.readFile("snowluma", "onebot");
      const parsed = JSON.parse(raw) as { networks?: { wsServers?: { accessToken?: string }[] } };
      const token = parsed.networks?.wsServers?.find((s) => s.accessToken)?.accessToken ?? "";
      return token.trim();
    } catch (err) {
      ctx.logger.warn(`读取 SnowLuma OneBot 配置失败: ${String(err)}`);
      return "";
    }
  };

  const storedToken = (id: RuntimeId): string => {
    const v = ctx.storage.get<unknown>(`runtime.token.${id}`, "");
    return typeof v === "string" ? v.trim() : "";
  };

  /** 生效 token:面板手填 > config 文件 > runtime 自身配置(自动抓取) */
  const effectiveToken = async (id: RuntimeId): Promise<string> => {
    return storedToken(id) || oneBotToken(id, cfg) || (await runtimeConfigToken(id));
  };

  const connect = async (id: RuntimeId): Promise<void> => {
    await adapter.connect(
      {
        url: oneBotUrl(id, cfg),
        token: await effectiveToken(id),
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
      login: selected === "snowluma" ? loginInfoOf(selected, cfg, await snowlumaInitialCredentials()) : loginInfoOf(selected, cfg),
      onebotToken: {
        override: storedToken(selected),
        effective: await effectiveToken(selected),
        autoRead: !storedToken(selected) && Boolean(await runtimeConfigToken(selected)),
      },
      lastError,
    };
  };

  const reconnect = async (): Promise<void> => {
    await disconnect();
    await connect(selected);
    lastError = null;
  };

  /**
   * SnowLuma 的 WebUI 初始账密只在容器首次启动日志里打印一次(取最后一次打印的为准);
   * noVNC 密码则不可信——容器重启后数据卷里的旧密码可能盖回日志打印值,
   * 所以把日志里出现过的候选逐个对真实 VNC 端口做认证握手,只用验证通过的那一个。
   * 结果做 60 秒节流缓存;容器重启(restart)后置空重取。
   */
  let initialCredentials: SnowlumaInitialCredentials | null = null;
  let initialCredentialsAt = 0;
  const lastMatch = (text: string, re: RegExp): RegExpExecArray | null => {
    let out: RegExpExecArray | null = null;
    for (let m = re.exec(text); m; m = re.exec(text)) out = m;
    return out;
  };
  const allMatches = (text: string, re: RegExp): string[] => {
    const out: string[] = [];
    for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1]!);
    return out;
  };
  /** 对 VNC 端口做一次真实 RFB 认证握手:single-DES 需要 OpenSSL legacy provider,用子进程跑 */
  const verifyVncPassword = (candidates: string[]): string | undefined => {
    if (!candidates.length || !ctx.supervisor) return undefined;
    const script = [
      "const net=require('net'),crypto=require('crypto');",
      "function k(pw){const b=Buffer.alloc(8);const s=Buffer.from(pw,'latin1').subarray(0,8);for(let i=0;i<8;i++){let c=s[i]||0,r=0;for(let j=0;j<8;j++)r|=((c>>j)&1)<<(7-j);b[i]=r;}return b;}",
      "const [host,cands]=process.argv.slice(1);",
      "(async()=>{for(const pw of cands.split(',')){try{",
      "const ok=await new Promise(res=>{const s=net.connect(5900,host);let st=0,n=0,buf=Buffer.alloc(0);const fin=x=>{s.destroy();res(x);};",
      "s.on('data',d=>{buf=Buffer.concat([buf,d]);",
      "if(st===0){if(buf.length<12)return;if(!buf.toString('latin1',0,12).startsWith('RFB'))return fin('no-rfb');s.write('RFB 003.008\\n');buf=buf.subarray(12);st=1;}",
      "if(st===1){if(buf.length<1)return;n=buf[0];if(buf.length<1+n)return;const t=buf.subarray(1,1+n);if(!t.includes(2))return fin('no-auth');s.write(Buffer.from([2]));buf=buf.subarray(1+n);st=2;}",
      "if(st===2){if(buf.length<16)return;const c=crypto.createCipheriv('des-ecb',k(pw),null);c.setAutoPadding(false);s.write(Buffer.concat([c.update(buf.subarray(0,16)),c.final()]));buf=buf.subarray(16);st=3;}",
      "if(st===3){if(buf.length<4)return;fin(buf.readInt32BE(0)===0?'ok':'bad');}});",
      "s.on('error',e=>fin('err'));setTimeout(()=>fin('timeout'),4000);});",
      "if(ok==='ok'){console.log(pw);return;}}catch{}}})();",
    ].join("\n");
    try {
      const r = spawnSync(process.execPath, ["--openssl-legacy-provider", "-e", script, ...candidates], {
        timeout: 20_000,
      });
      const out = (r.stdout?.toString() ?? "").trim();
      return out || undefined;
    } catch {
      return undefined;
    }
  };
  const snowlumaInitialCredentials = async (): Promise<SnowlumaInitialCredentials> => {
    if (initialCredentials && Date.now() - initialCredentialsAt < 60_000) return initialCredentials;
    const out: SnowlumaInitialCredentials = {};
    try {
      if (ctx.supervisor) {
        // 权威来源 1:noVNC 密码持久化在数据卷里,直接读文件(日志里打印的可能是已被覆盖的一次性值)
        try {
          const pw = (await ctx.supervisor.readFile("snowluma", "novnc")).trim();
          if (pw) out.vncPassword = pw;
        } catch (err) {
          ctx.logger.warn(`读取 SnowLuma VNC 密码文件失败: ${String(err)}`);
        }
        // 权威来源 2:OneBot token 在 onebot.json 的 wsServers[].accessToken
        const cfgToken = await runtimeConfigToken("snowluma");
        if (cfgToken) {
          out.onebotToken = cfgToken;
          out.onebotTokenSource = storedToken("snowluma")
            ? "面板手动设置优先"
            : "已从 SnowLuma 的 onebot.json 自动读取";
        } else if (storedToken("snowluma")) {
          out.onebotToken = storedToken("snowluma");
          out.onebotTokenSource = "面板手动设置";
        }

        const text = await ctx.supervisor.logs("snowluma", 4000);
        // WebUI 初始账密:只在首次启动日志里出现,取最后一次打印的
        const cred = lastMatch(text, /initial credentials:\s*user=(\S+)\s+password=(\S+)/g);
        if (cred) {
          out.webuiUser = cred[1];
          out.webuiPassword = cred[2];
        }
        // VNC 密码兜底:文件读不到时,把日志候选逐个对真实 5900 做握手验证
        if (!out.vncPassword) {
          const vncCandidates = allMatches(text, /(?:远程桌面密码|remote desktop password):\s*(\S+)/g).reverse();
          out.vncPassword = verifyVncPassword([...new Set(vncCandidates)]);
        }
      }
    } catch (err) {
      ctx.logger.warn(`解析 SnowLuma 初始凭据失败: ${String(err)}`);
    }
    initialCredentials = out;
    initialCredentialsAt = Date.now();
    return out;
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
      initialCredentials = null; // 容器重启后凭据可能变化,强制重新解析
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
          initialCredentials = null;
          try {
            await reconnect();
            return { body: { ok: true, state: await state() } };
          } catch (err) {
            lastError = `应用 token 后重连失败: ${String(err)}`;
            return { status: 502, body: { ok: false, error: lastError, state: await state() } };
          }
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
