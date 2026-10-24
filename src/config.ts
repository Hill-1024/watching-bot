import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ModelConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  /** 面板覆盖层写入的明文 key(优先于环境变量);基础配置一般不填 */
  apiKey?: string;
  contextWindow: number;
  /** 单次回复 token 上限(自定义端点用;目录模型自带) */
  maxTokens?: number;
  /** agent 推理档位:off|minimal|low|medium|high|xhigh|max */
  thinkingLevel?: string;
}

export interface TimeConfig {
  timeScale: number;
  /** 调试用固定起点;留空 = 全新启动以现实时间为锚(推荐) */
  simStart?: string;
  tickRealMs: number;
}

export interface StateVarDef {
  min: number;
  max: number;
  init: number;
}

export interface StateRules {
  fatiguePerSimHourAwake: number;
  fatiguePerTurn: number;
  fatigueRecoveryPerSimHour: number;
  annoyanceDecayPerSimHour: number;
  annoyancePerAlarmRing: number;
  annoyancePerStormTick: number;
  stressDecayPerSimHour: number;
  socialRecoveryPerSimHourAlone: number;
  moodRegressionToBaselinePerSimHour: number;
  moodBaseline: number;
}

export interface StateThresholds {
  drowsyInject: number;
  drowsyTier2: number;
  drowsyTier3: number;
  forcedSleep: number;
  naturalWake: number;
  drowsyOnWake: number;
  sleepHardCapSimMinutes: number;
  alarmRingIntervalSimMinutes: number;
  stormWindowSimMinutes: number;
  stormMinMentions: number;
  feelingRepeatCooldownSimMinutes: number;
}

export interface LoopConfig {
  heartbeatSimMinutes: number;
  emptyBackoffBaseSimMinutes: number;
  emptyBackoffMaxSimMinutes: number;
  perceptionFlushDelayMs: number;
  hotTailMessages: number;
}

export interface MemoryConfig {
  dataDir: string;
  memoryFile: string;
  diaryDir: string;
  consolidateDiaryDaysToWeek: number;
}

export interface SleepConfig {
  wakeOnStorm: boolean;
  maxSnoozeBeforeForcedWake: number;
}

export interface PanelConfig {
  enabled: boolean;
  port: number;
  tokenEnv: string;
}

export interface JudgeConfig {
  enabled: boolean;
  cooldownSimMinutes: number;
  maxCallsPerSimDay: number;
}

export interface AppConfig {
  model: ModelConfig;
  time: TimeConfig;
  modules: string[];
  moduleConfig: Record<string, unknown>;
  state: {
    vars: Record<string, StateVarDef>;
    rules: StateRules;
    thresholds: StateThresholds;
  };
  loop: LoopConfig;
  memory: MemoryConfig;
  sleep: SleepConfig;
  panel: PanelConfig;
  judge: JudgeConfig;
}

export function loadConfig(path = "config/default.json"): AppConfig {
  const raw = JSON.parse(readFileSync(resolve(path), "utf-8")) as AppConfig;
  return raw;
}

export function modelApiKey(cfg: ModelConfig): string {
  return process.env[cfg.apiKeyEnv] ?? "";
}
