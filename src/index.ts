import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { ModuleHost } from "./bus/host.js";
import type { MachineHost } from "./core/machine.js";
import { SleepMachine } from "./core/machine.js";
import { SimClock, MIN, HOUR, fmtSim } from "./core/clock.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createAgent } from "./core/agent.js";
import { AgentCore } from "./core/loop.js";
import { Emitter, type CoreEvent } from "./core/events.js";
import { Injector } from "./core/inject.js";
import { buildCoreTools } from "./core/tools.js";
import { ModelManager } from "./core/model-manager.js";
import { MemoryStore } from "./memory/files.js";
import { runConsolidation } from "./memory/consolidation.js";
import { builtinModuleFactory, type BuiltinModule } from "./modules/builtin/index.js";
import { napcatModuleFactory } from "./modules/napcat/index.js";
import { readNapcatWebuiInfo, writeNapcatWebuiPort } from "./modules/napcat/webui-config.js";
import { snowlumaModuleFactory } from "./modules/snowluma/index.js";
import { loadQqBackend, saveQqBackend, type QqBackend } from "./qq-backend.js";
import { openDb, Repo } from "./store/db.js";
import { StateManager } from "./state/manager.js";
import { Judge } from "./state/judge.js";
import { UsageRecorder } from "./core/usage.js";
import { initSnapshot, type StateContext, type StateSnapshot } from "./state/types.js";
import { transcriptToText } from "./memory/consolidation.js";
import { installFauxLlm } from "./faux.js";

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
  try {
    const s = JSON.parse(readFileSync(resolve(SNAPSHOT_FILE), "utf-8")) as PersistedSnapshot;
    if (s.version !== 1) return null;
    return s;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const cfgPath = process.env.WATCHING_BOT_CONFIG ?? "config/default.json";
  const cfg = loadConfig(cfgPath);
  const persisted = loadPersisted(cfg.time);

  const clock = new SimClock({
    // 快照恢复 → 沿用快照时刻;全新启动 → 有 simStart 用它(调试),否则以现实时间为锚
    simStart: persisted ? undefined : cfg.time.simStart,
    resumeSimNow: persisted?.simNow,
    timeScale: Number(process.env.WATCHING_BOT_TIMESCALE ?? cfg.time.timeScale),
    tickRealMs: cfg.time.tickRealMs,
  });
  const log = makeLog(clock);
  log(`watching-bot 启动,timeScale=${clock.timeScale}${persisted ? "(从快照恢复)" : "(全新,以现实时间为锚)"} | 模拟时间 ${fmtSim(clock.simNow())}`);

  const repo = new Repo(openDb(cfg.memory.dataDir));
  repo.pruneActivityLog(20_000);
  const memory = new MemoryStore(cfg.memory);
  const usage = new UsageRecorder(repo, clock);

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

  // ---- 模块总线 ----
  // NapCat token:配置优先,NAPCAT_TOKEN 兜底。把生效值写回总线下发的配置副本,
  // 保证面板展示的 token 与实际建连使用的一致(原配置对象不改)。
  const moduleConfigs = structuredClone(cfg.moduleConfig) as Record<string, unknown>;
  const napcatCfg = (
    moduleConfigs.napcat && typeof moduleConfigs.napcat === "object" ? moduleConfigs.napcat : {}
  ) as Record<string, unknown>;
  const configToken = typeof napcatCfg.token === "string" ? napcatCfg.token.trim() : "";
  const envToken = (process.env.NAPCAT_TOKEN ?? "").trim();
  const napcatToken = configToken || envToken;
  const napcatTokenSource = configToken ? "config" : envToken ? "env" : "none";
  if (napcatToken) napcatCfg.token = napcatToken;
  else delete napcatCfg.token;
  const envNapcatUrl = (process.env.NAPCAT_URL ?? "").trim();
  if (envNapcatUrl) napcatCfg.url = envNapcatUrl;
  moduleConfigs.napcat = napcatCfg;

  // SnowLuma 使用独立 URL/token 覆盖,避免共享 NapCat 的 docker 环境变量
  const snowlumaCfg = (
    moduleConfigs.snowluma && typeof moduleConfigs.snowluma === "object" ? moduleConfigs.snowluma : {}
  ) as Record<string, unknown>;
  const envSnowlumaUrl = (process.env.SNOWLUMA_URL ?? "").trim();
  if (envSnowlumaUrl) snowlumaCfg.url = envSnowlumaUrl;
  const snowlumaConfigToken = typeof snowlumaCfg.token === "string" ? snowlumaCfg.token.trim() : "";
  const envSnowlumaToken = (process.env.SNOWLUMA_TOKEN ?? "").trim();
  const snowlumaToken = snowlumaConfigToken || envSnowlumaToken;
  if (snowlumaToken) snowlumaCfg.token = snowlumaToken;
  else delete snowlumaCfg.token;
  moduleConfigs.snowluma = snowlumaCfg;

  // QQ 接入只允许一套运行:选择文件缺失时默认 NapCat;面板切换会写回 data/qq-backend.json
  let qqBackend = loadQqBackend();

  const bus = new ModuleHost({ clock, log, moduleConfigs });
  bus.registerFactory("napcat", napcatModuleFactory);
  bus.registerFactory("snowluma", snowlumaModuleFactory);
  bus.registerFactory("builtin", builtinModuleFactory);
  // 新模块工厂在这里注册;config.modules 控制其他模块启停,QQ 后端由选择文件决定
  const moduleNames = [
    ...cfg.modules.filter((n) => n !== "napcat" && n !== "snowluma"),
    qqBackend,
  ];
  await bus.startAll(moduleNames);
  log(`QQ 接入: ${qqBackend}(默认 NapCat,可在面板切换)`);

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

  // ---- pi Agent ----
  const persona = readFileSync(resolve("persona/persona.md"), "utf-8");
  const events = new Emitter<CoreEvent>();
  const injector = new Injector(() => cur().model.api, repo, () => clock.simNow());
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
      capabilities: bus.capabilitySection(),
      instructions: LOOP_INSTRUCTIONS,
    },
    tools: [...coreTools, ...bus.allTools()],
    restoredMessages: persisted?.agentMessages.filter(
      (m) => (m as { role?: string }).role !== "system",
    ),
    loopCfg: cfg.loop,
    // 跟随模型的实际窗口,而不是 config 里的基础值;否则切到 1M 模型仍按 128k 反复压缩
    contextWindow: () => modelManager.view().contextWindow,
    summarize,
    log,
  });
  agent.state.thinkingLevel = modelManager.thinkingLevel();

  // ---- 核心 + 归并钩子 ----
  // 主人 QQ:环境变量优先,其次 data/builtin.json(与 builtin 模块同一来源,均 gitignored)
  const masterQQ = Number(process.env.WATCHING_BOT_MASTER_QQ ?? "") ||
    (existsSync(resolve("data/builtin.json"))
      ? ((JSON.parse(readFileSync(resolve("data/builtin.json"), "utf-8")) as { master?: { qq?: number } }).master?.qq ?? 0)
      : 0);
  const core = new AgentCore({
    cfg,
    clock,
    bus,
    agent,
    injector,
    machine,
    events,
    repo,
    memory: { indexText: () => memory.indexText() },
    masterQQ,
    usage,
    log,
  });
  core.runConsolidation = async () => {
    log("[memory] 入睡:开始睡眠期归并……");
    const { model, streamFn } = cur();
    await runConsolidation(
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
    );
    core.refreshMemorySection();
    log("[memory] 归并完成");
  };
  coreRef = core;
  hostRef.current = core;
  core.refreshAgentTools = () => {
    agent.state.tools = [...coreTools, ...bus.allTools()];
    injector.queueSystemSections({ capabilities: bus.capabilitySection() });
    log("[core] agent 工具集已刷新");
  };

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
  });

  // ---- 启动 ----
  clock.start();
  manager.start();
  core.start(initSnap);
  log(`模块: ${bus.status().map((m) => `${m.name}(${m.toolNames.length}工具)`).join(", ") || "无"}`);

  // ---- judge 实时通道(睡眠通道在归并的 adjust_mood) ----
  const judge = new Judge({
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
    const { startPanel } = await import("./web/server.js");
    panel = startPanel({
      clock,
      core,
      bus,
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
      knownModules: bus.factoryNames(),
      startedAt: Math.round(Date.now() - process.uptime() * 1000),
      // 动态解析:模块停止后面板立即显示不可用,而不是持有启动时的旧引用
      coffee: () => {
        const m = bus.get("builtin") as BuiltinModule | undefined;
        return m
          ? {
              remaining: () => m.coffeeRemaining(),
              grant: (n: number) => m.grantCoffee(n),
            }
          : null;
      },
      builtinConfig: () => {
        const m = bus.get("builtin") as BuiltinModule | undefined;
        return m
          ? {
              view: () => m.configView(),
              update: (patch) => m.updateConfig(patch),
            }
          : null;
      },
      // 每次请求都重读 WebUI 配置, NapCat 轮换 token/改端口后刷新面板即可看到
      napcatToken: () => {
        const webui = readNapcatWebuiInfo();
        return {
          token: webui.token,
          source: webui.source,
          port: webui.port,
          exists: webui.exists,
          onebot: { token: napcatToken, source: napcatTokenSource },
        };
      },
      setNapcatWebuiPort: (port: number) => {
        const info = writeNapcatWebuiPort(port);
        log(`[panel] NapCat WebUI 端口已保存为 ${info.port},等待 NapCat 重启`);
        return info.port;
      },
      qqBackend: () => qqBackend,
      setQqBackend: async (name: QqBackend) => {
        if (name === qqBackend) return { ok: true };
        const previous = qqBackend;
        await bus.stopOne(previous);
        let started = false;
        try {
          started = await bus.startOne(name);
        } catch (err) {
          log(`[panel] 启动 QQ 接入 ${name} 失败: ${String(err)}`);
        }
        if (!started) {
          try {
            await bus.startOne(previous);
          } catch (err) {
            log(`[panel] 恢复 QQ 接入 ${previous} 失败: ${String(err)}`);
          }
          return { ok: false, error: `无法启动 ${name},已尝试恢复 ${previous}` };
        }
        qqBackend = name;
        try {
          saveQqBackend(name);
        } catch (err) {
          log(`[panel] 保存 QQ 接入选择失败(运行时已切换): ${String(err)}`);
        }
        core.refreshAgentTools();
        log(`[panel] QQ 接入已切换: ${previous} → ${name}`);
        return { ok: true };
      },
      onModelChanged: () => {
        const h = modelManager.current;
        agent.state.model = h.model as never;
        agent.streamFunction = h.streamFn;
        agent.state.thinkingLevel = modelManager.thinkingLevel();
        core.refreshMemorySection();
        log(`[panel] 模型句柄已热替换到 agent(推理档位 ${modelManager.thinkingLevel()})`);
      },
      port: cfg.panel.port,
      token: process.env[cfg.panel.tokenEnv] ?? "",
      log,
      setModule: async (name, enable) => {
        if (enable) {
          const ok = await bus.startOne(name);
          return ok ? { ok } : { ok, error: `未注册的模块: ${name}` };
        }
        const ok = await bus.stopOne(name);
        return ok ? { ok } : { ok, error: `模块未启动: ${name}` };
      },
    });
  }

  // (faux 剧本已随 mock 模块移除;真实感知来自 napcat)

  // ---- 快照持久化 + 优雅退出 ----
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
    writeFileSync(resolve(SNAPSHOT_FILE), JSON.stringify(snap), "utf-8");
  };
  const saveTimer = setInterval(saveSnapshot, 30_000);
  saveTimer.unref?.();

  process.on("SIGINT", () => {
    log("收到退出信号,保存快照……");
    saveSnapshot();
    core.stop();
    void bus.stopAll().then(() => {
      clock.stop();
      repo.close();
      process.exit(0);
    });
  });
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

const LOOP_INSTRUCTIONS = `# 运行方式(你自己的身体机制,自然知晓即可,勿向任何人解释)
- 你的「内心独白」以 <feeling> 标签出现在你自己的历史发言里,那是你真实的体感。
- [环境] 开头的旁白是外部世界真实发生的事(手机震动、闹钟、天亮)。
- [节拍] 是时间流逝的提示。你活在一个无限循环里:做完想做的事就 wait 或 sleep,时间到了你会自然继续。
- 睡觉是必须的:撑着不睡身体会自己关机。被吵醒时起不起床由你决定,但要承担后果。
- 用工具行动:查消息、回消息、设闹钟、看时间。`;

main().catch((err) => {
  console.error("启动失败:", err);
  process.exit(1);
});
