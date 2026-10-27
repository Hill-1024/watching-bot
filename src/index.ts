import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import type { MachineHost } from "./core/machine.js";
import { SleepMachine } from "./core/machine.js";
import { SimClock, MIN, HOUR, fmtSim } from "./core/clock.js";
import { loadConfig, type AppConfig } from "./config.js";
import { isValidSnapshot, resolveTimeScale } from "./config-schema.js";
import { createAgent } from "./core/agent.js";
import { AgentCore } from "./core/loop.js";
import { Emitter, type CoreEvent } from "./core/events.js";
import { Injector } from "./core/inject.js";
import { buildCoreTools } from "./core/tools.js";
import { ModelManager } from "./core/model-manager.js";
import { MemoryStore } from "./memory/files.js";
import { runConsolidation } from "./memory/consolidation.js";
import { PluginHost } from "./plugins/host.js";
import { loadQqBackend } from "./qq-backend.js";
import { SupervisorClient } from "./supervisor/client.js";
import { openDb, Repo } from "./store/db.js";
import { StateManager } from "./state/manager.js";
import { Judge } from "./state/judge.js";
import { UsageRecorder } from "./core/usage.js";
import { initSnapshot, type StateContext, type StateSnapshot } from "./state/types.js";
import { transcriptToText } from "./memory/consolidation.js";
import { installFauxLlm } from "./faux.js";
import { Coalescer, LiveHub, statusSnapshot } from "./web/live.js";

const SNAPSHOT_FILE = process.env.WATCHING_BOT_STATE_FILE ?? "data/state.json";

interface PersistedSnapshot {
  version: 1;
  simNow: number;
  vars: Record<string, number>;
  phase: string;
  sleepStartedSim: number | null;
  snoozeCount: number;
  agentMessages: AgentMessage[];
}

function makeLog(clock: SimClock) {
  return (msg: string) => {
    console.log(`[${fmtSim(clock.simNow())} | real ${new Date().toLocaleTimeString()}] ${msg}`);
  };
}

function loadPersisted(clockCfg: AppConfig["time"]): PersistedSnapshot | null {
  if (!existsSync(resolve(SNAPSHOT_FILE))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolve(SNAPSHOT_FILE), "utf-8"));
  } catch (err) {
    console.warn(`[snapshot] ${SNAPSHOT_FILE} 解析失败,忽略快照: ${String(err)}`);
    return null;
  }
  if (!isValidSnapshot(parsed)) {
    // 不静默全量重置:留下明确日志,便于人工从备份恢复
    console.warn(`[snapshot] ${SNAPSHOT_FILE} 结构不合法(版本/字段缺失),按全新启动继续`);
    return null;
  }
  return parsed as PersistedSnapshot;
}

async function main(): Promise<void> {
  const cfgPath = process.env.WATCHING_BOT_CONFIG ?? "config/default.json";
  const cfg = loadConfig(cfgPath);
  const persisted = loadPersisted(cfg.time);

  const clock = new SimClock({
    // 快照恢复 → 沿用快照时刻;全新启动 → 有 simStart 用它(调试),否则以现实时间为锚
    simStart: persisted ? undefined : cfg.time.simStart,
    resumeSimNow: persisted?.simNow,
    timeScale: resolveTimeScale(cfg.time.timeScale),
    tickRealMs: cfg.time.tickRealMs,
  });
  const log = makeLog(clock);
  log(`watching-bot 启动,timeScale=${clock.timeScale}${persisted ? "(从快照恢复)" : "(全新,以现实时间为锚)"} | 模拟时间 ${fmtSim(clock.simNow())}`);

  const repo = new Repo(openDb(cfg.memory.dataDir));
  const pruned = repo.pruneHistory();
  if (pruned.state + pruned.injections + pruned.usage + pruned.activity > 0) {
    log(`[store] 启动清理历史 ${JSON.stringify(pruned)}`);
  }
  const pruneTimer = setInterval(() => repo.pruneHistory(), 10 * 60_000);
  pruneTimer.unref?.();
  const memory = new MemoryStore(cfg.memory);

  // ---- 事件推送:面板只在这个 hub 说「变了」时更新,不轮询 ----
  const live = new LiveHub();
  const signals = new Coalescer((topic, data) => live.publish(topic, data), 1000);
  const windowFor = (topic: string): number => {
    // 插件进度是逐步事实,不能和状态心跳挤在同一个合并窗口里
    if (topic.startsWith("plugin:")) return 0;
    if (topic === "state") return 4000;
    if (topic === "usage") return 2000;
    if (topic === "plugins") return 500;
    return 1000;
  };
  const publish = (topic: string, data?: unknown) =>
    signals.push(topic, data, { windowMs: windowFor(topic) });
  const usage = new UsageRecorder(repo, clock, () => publish("usage"));

  // ---- LLM:faux(测试剧本)或真实模型(pi 网关 + ModelManager 热切换) ----
  const faux = process.env.WATCHING_BOT_FAUX_LLM === "1";
  const modelManager = new ModelManager(cfg.model, { dataDir: cfg.memory.dataDir, log, faux });
  if (!faux) {
    const v = modelManager.view();
    log(`模型: ${v.provider}/${v.model}${v.baseUrl ? ` @ ${v.baseUrl}` : " (pi 目录端点)"}${v.apiKeySet ? "" : " [warn] 未配置 API key,调用将失败"}`);
  }
  const fauxLlm = faux ? installFauxLlm() : null;
  /** 当前模型句柄(面板热切换后随之变化) */
  const cur = () => (fauxLlm ? { model: fauxLlm.model, streamFn: fauxLlm.streamFn } : modelManager.current);
  const curApiKey = (): string | undefined => (fauxLlm ? undefined : modelManager.apiKey());

  // ---- 插件配置(旧 napcat/snowluma 配置与选择文件自动迁移到 qq 插件) ----
  const moduleConfigs = buildPluginConfigs(cfg);

  // ---- 睡醒状态机(late-bound host:core 建好后回填) ----
  const hostRef: { current: MachineHost | null } = { current: null };
  const machine = new SleepMachine(lateBoundHost(hostRef));

  // ---- 核心工具(睡眠/起床/等待/闹钟/时间) ----
  let coreRef: AgentCore | null = null;
  const coreTools = buildCoreTools({
    clock,
    machine,
    repo,
    scheduleKickIn: (ms, reason) => coreRef?.scheduleKickIn(ms, reason),
    log,
  });

  // ---- 插件宿主 ----
  // 核心不认识任何具体插件:PluginHost 从 plugins/*/module.json 发现、校验、启停,
  // 并按 ModuleBus 契约提供工具/能力段/感知。
  const supervisorUrl = (process.env.WATCHING_BOT_SUPERVISOR_URL ?? "").trim();
  const supervisorToken = (process.env.WATCHING_BOT_SUPERVISOR_TOKEN ?? "").trim();
  const supervisor =
    supervisorUrl && supervisorToken ? new SupervisorClient(supervisorUrl, supervisorToken) : undefined;
  if (!supervisor) log("[plugins] 未配置 runtime supervisor,QQ runtime 只能本地直连");

  const plugins = new PluginHost({
    pluginsRoot: process.env.WATCHING_BOT_PLUGINS_DIR ?? "plugins",
    dataDir: cfg.memory.dataDir,
    clock,
    log,
    moduleConfigs,
    supervisor,
    reservedToolNames: coreTools.map((t) => t.name),
    publish: (topic, data) => {
      // 插件状态列表直接随事件下发,省一次往返。
      // 带 data 的事件(切换进度)必须立刻到,不能被窗口合并。
      if (topic === "plugins") {
        // 实现名变了必须马上到总览;内容相同就不发,避免重连把卡片刷闪
        const snapshot = { plugins: plugins.plugins(), modules: plugins.status() };
        signals.push("plugins", snapshot, { immediate: true, windowMs: 0 });
      } else if (data !== undefined) {
        signals.invalidate(topic);
        live.publish(topic, data);
      } else {
        publish(topic);
      }
    },
  });
  await plugins.startAll(cfg.modules);
  log(`插件: ${plugins.plugins().map((p) => `${p.id}(${p.toolNames.length}工具)`).join(", ") || "无"}`);

  // ---- pi Agent ----
  const persona = readFileSync(resolve("persona/persona.md"), "utf-8");
  const events = new Emitter<CoreEvent>();
  const injector = new Injector(() => cur().model.api, repo, () => clock.simNow(), () => publish("injections"));
  const summarize = async (messages: AgentMessage[]) => {
    const { model, streamFn } = cur();
    const { text, usage: u } = await generateSummaryWithUsage(
      messages,
      model as never,
      8192,
      curApiKey(),
      undefined,
      undefined,
      "这是一位过日常生活的虚拟角色的对话记录。摘要保留:人物与关系、情绪事件、重要约定与承诺、未完成的事;忽略工具调用的技术细节。",
      undefined,
      modelManager.thinkingLevel(),
      streamFn,
    );
    usage.record("compaction", u, {
      model: (model as { id?: string }).id,
      provider: (model as { provider?: string }).provider,
      tsSim: clock.simNow(),
    });
    return text;
  };
  const initLlm = cur();
  const { agent } = createAgent({
    model: initLlm.model as never,
    streamFn: initLlm.streamFn,
    systemPrompt: persona,
    sections: {
      memory: memory.indexText(),
      capabilities: plugins.capabilitySection(),
      instructions: LOOP_INSTRUCTIONS,
    },
    tools: [...coreTools, ...plugins.allTools()],
    restoredMessages: persisted?.agentMessages.filter(
      (m) => (m as { role?: string }).role !== "system",
    ),
    loopCfg: cfg.loop,
    // 跟随模型的实际窗口,而不是 config 里的基础值;否则切到 1M 模型仍按 128k 反复压缩
    contextWindow: () => modelManager.contextWindow(),
    summarize,
    log,
  });
  agent.state.thinkingLevel = modelManager.thinkingLevel();

  let pushStatus: (immediate?: boolean) => void = () => {};

  // ---- 核心 + 归并钩子 ----
  // 主人 QQ:环境变量优先,其次 data/builtin.json(与 builtin 模块同一来源,均 gitignored)
  const masterQQ = Number(process.env.WATCHING_BOT_MASTER_QQ ?? "") ||
    (existsSync(resolve("data/builtin.json"))
      ? ((JSON.parse(readFileSync(resolve("data/builtin.json"), "utf-8")) as { master?: { qq?: number } }).master?.qq ?? 0)
      : 0);
  const core = new AgentCore({
    cfg,
    clock,
    bus: plugins,
    agent,
    injector,
    machine,
    events,
    repo,
    memory: { indexText: () => memory.indexText() },
    masterQQ,
    usage,
    log,
    onActivity: () => publish("activity"),
  });
  let consolidating: Promise<void> | null = null;
  core.runConsolidation = async () => {
    if (consolidating) {
      log("[memory] 归并已在进行,等待当前这一次结束");
      return consolidating;
    }
    log("[memory] 开始睡眠期归并……");
    const { model, streamFn } = cur();
    consolidating = runConsolidation(
      {
        model: model as never,
        streamFn,
        memory,
        weekSize: cfg.memory.consolidateDiaryDaysToWeek,
        persona,
        onUsage: (u, message, source) =>
          usage.record(source ?? "memory", u as never, { ...message, tsSim: clock.simNow() }),
        onSleepCorrection: (moodDelta, stressDelta, reason) => {
          manager.applyJudgeCorrection(moodDelta, stressDelta);
          log(`[memory] 睡眠通道情绪结算 mood${moodDelta >= 0 ? "+" : ""}${moodDelta} stress+${stressDelta}(${reason})`);
        },
        log,
      },
      agent.state.messages,
      clock.simNow(),
    )
      .then(() => {
        core.refreshMemorySection();
        publish("memory");
        log("[memory] 归并完成");
      })
      .finally(() => {
        consolidating = null;
      });
    return consolidating;
  };
  coreRef = core;
  hostRef.current = core;
  core.refreshAgentTools = () => {
    agent.state.tools = [...coreTools, ...plugins.allTools()];
    injector.queueSystemSections({ capabilities: plugins.capabilitySection() });
    log("[core] agent 工具集已刷新");
  };
  // 插件启停 → 核心自动刷新工具集,不再由每个 Web 路由手动触发
  plugins.onToolsChanged(() => core.refreshAgentTools());

  // ---- 状态管理器 ----
  const stateCtx: StateContext = {
    defs: cfg.state.vars,
    rules: cfg.state.rules,
    thresholds: cfg.state.thresholds,
  };
  const initSnap: StateSnapshot = initSnapshot(stateCtx);
  if (persisted) {
    Object.assign(initSnap.vars, persisted.vars);
    initSnap.sleepStartedSim = persisted.sleepStartedSim;
    initSnap.snoozeCount = persisted.snoozeCount;
    if (persisted.phase !== "awake") {
      // 重启时一律以清醒态恢复运行(简化:睡眠中的进程被杀,醒来继续)
      machine.phase = "awake";
    }
  }
  const manager = new StateManager({
    events: core.events,
    core,
    ctx: stateCtx,
    thresholds: cfg.state.thresholds,
    judge: cfg.judge,
    simNow: () => clock.simNow(),
    log,
    onChange: () => {
      publish("state");
      pushStatus();
    },
  });

  // status 变化才推;窗口内合并,内容相同直接丢弃
  pushStatus = (immediate = false) => {
    const snapshot = statusSnapshot({ clock, core, state: manager });
    const hash =
      JSON.stringify(snapshot.vars) +
      snapshot.phase +
      snapshot.timeScale +
      snapshot.snoozeCount +
      snapshot.activityLastSeq;
    // 2s 合并:数字不追着每个 tick 闪;模拟时钟由前端按 simMs 外推,依然连续
    signals.push("status", snapshot, { immediate, hash, windowMs: 2000 });
  };

  // 状态变化由 manager.onChange 统一驱动;这里只补 phase 这种「立刻要看到」的切换
  core.events.on((e) => {
    if (e.type === "phase_changed") {
      publish("state");
      pushStatus(true);
    }
  });

  // ---- 启动 ----
  clock.start();
  manager.start();
  core.start(initSnap);
  log(`插件: ${plugins.status().map((m) => `${m.name}(${m.toolNames.length}工具)`).join(", ") || "无"}`);

  // ---- judge 实时通道(睡眠通道在归并的 adjust_mood) ----
  const judge = new Judge({
    enabled: cfg.judge.enabled,
    events: core.events,
    manager,
    getModel: () => cur().model as never,
    getStreamFn: () => cur().streamFn,
    getApiKey: () => curApiKey(),
    getPersona: () => persona,
    onUsage: (u, message) => usage.record("judge", u as never, { ...message, tsSim: clock.simNow() }),
    recentTranscript: () => transcriptToText(agent.state.messages, 4000),
    log,
  });
  judge.start();

  // ---- 管理面板 ----
  let panel: { stop(): void } | null = null;
  if (cfg.panel.enabled) {
    if (!process.env[cfg.panel.tokenEnv]) {
      log(`[panel][warn] ${cfg.panel.tokenEnv} 未设置:本机任何进程都能操作 agent,请在生产环境配置 token`);
    }
    const { startPanel } = await import("./web/server.js");
    panel = startPanel({
      clock,
      core,
      plugins,
      state: manager,
      live,
      repo,
      modelManager,
      memory: {
        indexText: () => memory.indexText(),
        indexPath: () => memory.indexPath(),
        diaryPath: (date) => memory.diaryPath(date),
        listDiaryDates: () => memory.listDiaryDates(),
        readDiary: (date) => memory.readDiary(date),
      },
      varDefs: cfg.state.vars,
      startedAt: Math.round(Date.now() - process.uptime() * 1000),
      onModelChanged: () => {
        const h = modelManager.current;
        agent.state.model = h.model as never;
        agent.streamFunction = h.streamFn;
        agent.state.thinkingLevel = modelManager.thinkingLevel();
        core.refreshMemorySection();
        log(`[panel] 模型句柄已热替换到 agent(推理档位 ${modelManager.thinkingLevel()})`);
      },
      port: cfg.panel.port,
      host: process.env.WATCHING_BOT_PANEL_HOST ?? "127.0.0.1",
      token: process.env[cfg.panel.tokenEnv] ?? "",
      log,
    });
  }

  // (faux 剧本已随 mock 模块移除;真实感知来自插件)

  // ---- 快照持久化 + 优雅退出 ----
  // 临时文件写完再 rename:中途被杀不会留下半截 JSON 覆盖上一份好快照。
  const saveSnapshot = () => {
    const snap: PersistedSnapshot = {
      version: 1,
      simNow: clock.simNow(),
      vars: core.snapshot.vars,
      phase: machine.phase,
      sleepStartedSim: machine.sleepStartedSim,
      snoozeCount: machine.snoozeCount,
      agentMessages: agent.state.messages,
    };
    const path = resolve(SNAPSHOT_FILE);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        copyFileSync(path, `${path}.bak`);
      } catch (err) {
        log(`[snapshot] 备份上一份失败(继续写新快照): ${String(err)}`);
      }
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), "utf-8");
    renameSync(tmp, path);
  };
  const saveTimer = setInterval(saveSnapshot, 30_000);
  saveTimer.unref?.();

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`收到 ${signal},保存快照并退出……`);
    clearInterval(saveTimer);
    clearInterval(pruneTimer);
    const force = setTimeout(() => {
      log("退出超时,强制结束");
      process.exit(1);
    }, 12_000);
    force.unref?.();
    try {
      saveSnapshot();
    } catch (err) {
      log(`[snapshot] 退出时保存失败: ${String(err)}`);
    }
    core.stop();
    panel?.stop();
    void plugins.stopAll().finally(() => {
      clock.stop();
      repo.close();
      clearTimeout(force);
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** late-bound MachineHost:core 构造完成前 machine 就存在 */
function lateBoundHost(ref: { current: MachineHost | null }): MachineHost {
  const method = <K extends keyof MachineHost>(k: K): MachineHost[K] => {
    // 返回绑定委托:调用时转发到当前 core,避免方法抽取丢失 this
    return ((...args: unknown[]) => {
      const cur = ref.current;
      if (!cur) throw new Error(`MachineHost 尚未就绪(访问 ${String(k)})`);
      return (cur[k] as (...a: unknown[]) => unknown)(...args);
    }) as MachineHost[K];
  };
  const getter = <K extends keyof MachineHost>(k: K): MachineHost[K] => {
    const cur = ref.current;
    if (!cur) throw new Error(`MachineHost 尚未就绪(访问 ${String(k)})`);
    return cur[k];
  };
  return {
    simNow: method("simNow"),
    injectEnv: method("injectEnv"),
    injectRawEnv: method("injectRawEnv"),
    injectFeeling: method("injectFeeling"),
    requestKick: method("requestKick"),
    get events() {
      return getter("events");
    },
    get repo() {
      return getter("repo");
    },
    runConsolidation: method("runConsolidation"),
    fatigueNow: method("fatigueNow"),
    drowsyOnWakeThreshold: method("drowsyOnWakeThreshold"),
    minFatigueToSleep: method("minFatigueToSleep"),
  };
}

/**
 * 把旧配置与旧选择文件迁移成 qq 插件配置。
 *
 * 兼容策略:moduleConfig.qq 优先;缺失字段回落到旧的 napcat/snowluma 段,
 * 这样已有部署升级后不必改配置。环境变量优先级最高。
 */
function buildPluginConfigs(cfg: AppConfig): Record<string, unknown> {
  const out = structuredClone(cfg.moduleConfig) as Record<string, unknown>;
  const asObj = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};
  const env = (name: string): string => (process.env[name] ?? "").trim();
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  const legacyNapcat = asObj(out.napcat);
  const legacySnowluma = asObj(out.snowluma);
  const qq = asObj(out.qq);

  for (const key of ["selfId", "dbPath", "memeDir", "sendMinIntervalMs", "sendJitterMs"]) {
    const v = qq[key] ?? legacyNapcat[key] ?? legacySnowluma[key];
    if (v !== undefined) qq[key] = v;
  }
  qq.runtime = qq.runtime ?? loadQqBackend();

  // 有 supervisor 时走内网别名,旧的 127.0.0.1 地址会让容器连不上
  const hasSupervisor = Boolean(env("WATCHING_BOT_SUPERVISOR_URL"));
  const napcatUrl = env("NAPCAT_URL") || (hasSupervisor ? "" : str(qq.napcatUrl) || str(legacyNapcat.url));
  const snowlumaUrl = env("SNOWLUMA_URL") || (hasSupervisor ? "" : str(qq.snowlumaUrl) || str(legacySnowluma.url));
  if (napcatUrl) qq.napcatUrl = napcatUrl;
  if (snowlumaUrl) qq.snowlumaUrl = snowlumaUrl;

  const napcatToken = str(qq.napcatToken) || str(legacyNapcat.token) || env("NAPCAT_TOKEN");
  const snowlumaToken = str(qq.snowlumaToken) || str(legacySnowluma.token) || env("SNOWLUMA_TOKEN");
  if (napcatToken) qq.napcatToken = napcatToken;
  if (snowlumaToken) qq.snowlumaToken = snowlumaToken;

  const supervisorUrl = env("WATCHING_BOT_SUPERVISOR_URL");
  if (supervisorUrl) qq.supervisorUrl = supervisorUrl;

  out.qq = qq;
  return out;
}

const LOOP_INSTRUCTIONS = `# 运行方式(你自己的身体机制,自然知晓即可,勿向任何人解释)- 你的「内心独白」以 <feeling> 标签出现在你自己的历史发言里,那是你真实的体感。
- [环境] 开头的旁白是外部世界真实发生的事(手机震动、闹钟、天亮)。
- [节拍] 是时间流逝的提示。你活在一个无限循环里:做完想做的事就 wait 或 sleep,时间到了你会自然继续。
- 睡觉是必须的:撑着不睡身体会自己关机。被吵醒时起不起床由你决定,但要承担后果。
- 用工具行动:查消息、回消息、设闹钟、看时间。`;

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
