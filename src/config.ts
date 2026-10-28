import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateConfig } from "./config-schema.js";

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
  /** 重启时把模拟钟对齐真实时间(默认 true,仅 timeScale=1 生效) */
  syncOnResume?: boolean;
  /** 允许的偏差(模拟分钟);超过就对齐,默认 10 */
  maxResumeDriftSimMinutes?: number;
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
  /** 一条环境闲聊消息对社交电量的消耗(按强度线性) */
  socialPerMessageIntensity: number;
  /** 一次主动社交工具调用对社交电量的消耗 */
  socialPerSocialTool: number;
  /** 高频事件限率窗口(模拟分钟);0 = 不限率 */
  pulseWindowSimMinutes: number;
  /** 单窗口允许落地的感知强度总和 */
  maxPerceptionIntensityPerWindow: number;
  /** 单窗口允许落地的主动社交工具调用次数 */
  maxSocialToolsPerWindow: number;
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
  /** 生效上下文窗口上限(默认 64000):让 pi compaction 在网关节点/体积限制前触发 */
  contextWindowCap?: number;
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
  /** 疲惫低于此值时 sleep 工具拒绝入睡(不困的人睡不着) */
  minFatigueToSleep: number;
  /** 睡眠中私聊消息是否可以叫醒(累积达到阈值触发唤醒决策) */
  wakeOnPrivateMessage: boolean;
  /** 普通人私聊叫醒所需条数 */
  privateWakeMessages: number;
  /** 主人私聊叫醒所需条数(豁免额度) */
  masterPrivateWakeMessages: number;
  privateWakeWindowSimMinutes: number;
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
  const text = readFileSync(resolve(path), "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${path}: JSON 解析失败(${String(err)})`);
  }
  return validateConfig(raw, path);
}

export function modelApiKey(cfg: ModelConfig): string {
  return process.env[cfg.apiKeyEnv] ?? "";
}
