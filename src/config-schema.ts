import { Type } from "typebox";
import { Value } from "typebox/value";
import type { AppConfig } from "./config.js";

/**
 * 配置的运行时校验。
 *
 * 原则:能在启动前失败就绝不等到运行中。
 * 一个坏的 timeScale 或倒置的阈值,如果在 agent 跑了几小时之后才表现为
 * 「状态曲线很怪」,排查成本远高于启动时报一行带字段路径的错误。
 */

const Num = Type.Number();
const NonNeg = Type.Number({ minimum: 0 });
const PosInt = Type.Number({ minimum: 1 });

const ModelSchema = Type.Object({
  provider: Type.String({ minLength: 1 }),
  baseUrl: Type.String(),
  model: Type.String({ minLength: 1 }),
  apiKeyEnv: Type.String({ minLength: 1 }),
  apiKey: Type.Optional(Type.String()),
  contextWindow: PosInt,
  maxTokens: Type.Optional(PosInt),
  thinkingLevel: Type.Optional(Type.String()),
});

const TimeSchema = Type.Object({
  timeScale: Type.Number({ exclusiveMinimum: 0 }),
  simStart: Type.Optional(Type.String()),
  tickRealMs: PosInt,
  /** 重启时把模拟钟对齐真实时间(默认 true,仅 timeScale=1 生效) */
  syncOnResume: Type.Optional(Type.Boolean()),
  /** 允许的偏差(模拟分钟);超过就对齐,默认 10 */
  maxResumeDriftSimMinutes: Type.Optional(NonNeg),
});

const StateVarDefSchema = Type.Object({
  min: Num,
  max: Num,
  init: Num,
});

const StateRulesSchema = Type.Object({
  fatiguePerSimHourAwake: NonNeg,
  fatiguePerTurn: NonNeg,
  fatigueRecoveryPerSimHour: NonNeg,
  annoyanceDecayPerSimHour: NonNeg,
  annoyancePerAlarmRing: NonNeg,
  annoyancePerStormTick: NonNeg,
  stressDecayPerSimHour: NonNeg,
  socialRecoveryPerSimHourAlone: NonNeg,
  socialPerMessageIntensity: NonNeg,
  socialPerSocialTool: NonNeg,
  pulseWindowSimMinutes: NonNeg,
  maxPerceptionIntensityPerWindow: NonNeg,
  maxSocialToolsPerWindow: NonNeg,
  moodRegressionToBaselinePerSimHour: NonNeg,
  moodBaseline: Num,
});

const StateThresholdsSchema = Type.Object({
  drowsyInject: Num,
  drowsyTier2: Num,
  drowsyTier3: Num,
  forcedSleep: Num,
  naturalWake: Num,
  drowsyOnWake: Num,
  sleepHardCapSimMinutes: Type.Number({ exclusiveMinimum: 0 }),
  alarmRingIntervalSimMinutes: Type.Number({ exclusiveMinimum: 0 }),
  stormWindowSimMinutes: Type.Number({ exclusiveMinimum: 0 }),
  stormMinMentions: PosInt,
  feelingRepeatCooldownSimMinutes: NonNeg,
});

const LoopSchema = Type.Object({
  heartbeatSimMinutes: Type.Number({ exclusiveMinimum: 0 }),
  emptyBackoffBaseSimMinutes: Type.Number({ exclusiveMinimum: 0 }),
  emptyBackoffMaxSimMinutes: Type.Number({ exclusiveMinimum: 0 }),
  perceptionFlushDelayMs: NonNeg,
  hotTailMessages: PosInt,
  contextWindowCap: Type.Optional(PosInt),
});

const MemorySchema = Type.Object({
  dataDir: Type.String({ minLength: 1 }),
  memoryFile: Type.String({ minLength: 1 }),
  diaryDir: Type.String({ minLength: 1 }),
  consolidateDiaryDaysToWeek: PosInt,
});

const SleepSchema = Type.Object({
  wakeOnStorm: Type.Boolean(),
  maxSnoozeBeforeForcedWake: PosInt,
  minFatigueToSleep: Num,
  wakeOnPrivateMessage: Type.Boolean(),
  privateWakeMessages: PosInt,
  masterPrivateWakeMessages: PosInt,
  privateWakeWindowSimMinutes: Type.Number({ exclusiveMinimum: 0 }),
});

const PanelSchema = Type.Object({
  enabled: Type.Boolean(),
  port: Type.Number({ minimum: 1, maximum: 65535 }),
  tokenEnv: Type.String({ minLength: 1 }),
});

const JudgeSchema = Type.Object({
  enabled: Type.Boolean(),
  cooldownSimMinutes: NonNeg,
  maxCallsPerSimDay: NonNeg,
});

export const AppConfigSchema = Type.Object(
  {
    model: ModelSchema,
    time: TimeSchema,
    modules: Type.Array(Type.String({ minLength: 1 })),
    moduleConfig: Type.Record(Type.String(), Type.Unknown()),
    state: Type.Object({
      vars: Type.Record(Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]*$" }), StateVarDefSchema),
      rules: StateRulesSchema,
      thresholds: StateThresholdsSchema,
    }),
    loop: LoopSchema,
    memory: MemorySchema,
    sleep: SleepSchema,
    panel: PanelSchema,
    judge: JudgeSchema,
  },
  { additionalProperties: true },
);

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 校验并返回配置;任何结构/取值/跨字段问题都汇总成一条可读错误 */
export function validateConfig(raw: unknown, source = "config"): AppConfig {
  const issues: string[] = [];

  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`${source}: 顶层必须是一个 JSON 对象`, ["$: 期望 object"]);
  }

  if (!Value.Check(AppConfigSchema, raw)) {
    for (const error of Value.Errors(AppConfigSchema, raw)) {
      issues.push(`${error.instancePath || "$"}: ${error.message}`);
      if (issues.length >= 20) break;
    }
  } else {
    issues.push(...crossFieldIssues(raw as AppConfig));
  }

  if (issues.length > 0) {
    throw new ConfigError(`${source}: 配置校验失败\n  - ${issues.join("\n  - ")}`, issues);
  }
  return raw as AppConfig;
}

/** 单字段 schema 表达不了的跨字段约束 */
function crossFieldIssues(cfg: AppConfig): string[] {
  const out: string[] = [];
  const t = cfg.state.thresholds;

  for (const [name, def] of Object.entries(cfg.state.vars)) {
    if (!Number.isFinite(def.min) || !Number.isFinite(def.max) || !Number.isFinite(def.init)) {
      out.push(`state.vars.${name}: 必须是有限数`);
    }
    if (def.min > def.max) out.push(`state.vars.${name}: min(${def.min}) 大于 max(${def.max})`);
    if (def.init < def.min || def.init > def.max) {
      out.push(`state.vars.${name}: init(${def.init}) 不在 [${def.min}, ${def.max}] 内`);
    }
  }

  if (!(t.drowsyInject <= t.drowsyTier2 && t.drowsyTier2 <= t.drowsyTier3)) {
    out.push(`state.thresholds: 疲惫体感阈值必须递增(drowsyInject ≤ drowsyTier2 ≤ drowsyTier3)`);
  }
  if (t.drowsyTier3 >= t.forcedSleep) {
    out.push(`state.thresholds: drowsyTier3(${t.drowsyTier3}) 必须低于 forcedSleep(${t.forcedSleep})`);
  }
  if (t.naturalWake >= t.forcedSleep) {
    out.push(`state.thresholds: naturalWake(${t.naturalWake}) 必须低于 forcedSleep(${t.forcedSleep})`);
  }
  if (t.naturalWake >= t.drowsyOnWake) {
    out.push(`state.thresholds: naturalWake(${t.naturalWake}) 应低于 drowsyOnWake(${t.drowsyOnWake})`);
  }

  if (cfg.time.simStart) {
    const parsed = Date.parse(cfg.time.simStart);
    if (!Number.isFinite(parsed)) out.push(`time.simStart: 不是合法时间(${cfg.time.simStart})`);
  }

  if (cfg.loop.emptyBackoffMaxSimMinutes < cfg.loop.emptyBackoffBaseSimMinutes) {
    out.push("loop: emptyBackoffMaxSimMinutes 必须 ≥ emptyBackoffBaseSimMinutes");
  }

  if (cfg.sleep.minFatigueToSleep < 0) out.push("sleep.minFatigueToSleep: 不能为负");

  const scaleEnv = process.env.WATCHING_BOT_TIMESCALE;
  if (scaleEnv !== undefined && scaleEnv !== "") {
    const parsed = Number(scaleEnv);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      out.push(`环境变量 WATCHING_BOT_TIMESCALE: 必须是 >0 的有限数,当前为 "${scaleEnv}"`);
    }
  }

  return out;
}

/** 解析环境变量里的 timeScale;非法值直接报错,不静默回退 */
export function resolveTimeScale(fallback: number, raw = process.env.WATCHING_BOT_TIMESCALE): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(`WATCHING_BOT_TIMESCALE 必须是 >0 的有限数,当前为 "${raw}"`, [
      `WATCHING_BOT_TIMESCALE: 非法值 "${raw}"`,
    ]);
  }
  return parsed;
}

/** 恢复的快照只做结构校验;损坏时由调用方决定回退策略 */
export const SnapshotSchema = Type.Object(
  {
    version: Type.Literal(1),
    simNow: Type.Number(),
    vars: Type.Record(Type.String(), Type.Number()),
    phase: Type.String(),
    sleepStartedSim: Type.Union([Type.Number(), Type.Null()]),
    snoozeCount: Type.Number(),
    agentMessages: Type.Array(Type.Unknown()),
  },
  { additionalProperties: true },
);

export function isValidSnapshot(raw: unknown): boolean {
  return Value.Check(SnapshotSchema, raw);
}
